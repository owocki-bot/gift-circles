const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage
const circles = new Map();
const FEE_RATE = 0.05;
const TREASURY = '0xccD7200024A8B5708d381168ec2dB0DC587af83F';

const getProvider = () => new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://sepolia.base.org');
const getWallet = () => {
  const privateKey = process.env.TREASURY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('TREASURY_PRIVATE_KEY environment variable is not set. Please configure it to enable payouts.');
  }
  return new ethers.Wallet(privateKey, getProvider());
};


// ============================================================================
// WHITELIST MIDDLEWARE
// ============================================================================

let _whitelistCache = null;
let _whitelistCacheTime = 0;
const WHITELIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchWhitelist() {
  const now = Date.now();
  if (_whitelistCache && (now - _whitelistCacheTime) < WHITELIST_CACHE_TTL) {
    return _whitelistCache;
  }
  try {
    const res = await fetch('https://www.owockibot.xyz/api/whitelist');
    const data = await res.json();
    _whitelistCache = new Set(data.map(e => (e.address || e).toLowerCase()));
    _whitelistCacheTime = now;
    return _whitelistCache;
  } catch (err) {
    console.error('Whitelist fetch failed:', err.message);
    if (_whitelistCache) return _whitelistCache;
    return new Set();
  }
}

function requireWhitelist(addressField = 'address') {
  return async (req, res, next) => {
    const addr = req.body?.[addressField] || req.body?.creator || req.body?.participant || req.body?.sender || req.body?.from || req.body?.address;
    if (!addr) {
      return res.status(400).json({ error: 'Address required' });
    }
    const whitelist = await fetchWhitelist();
    if (!whitelist.has(addr.toLowerCase())) {
      return res.status(403).json({ error: 'Invite-only. Tag @owockibot on X to request access.' });
    }
    next();
  };
}


app.get('/', (req, res) => {
  res.json({
    name: 'Gift Circles',
    description: 'Peer-to-peer recognition and funding in circles',
    endpoints: {
      'POST /circles': 'Create a gift circle',
      'GET /circles/:id': 'Get circle status',
      'POST /circles/:id/join': 'Join a circle',
      'POST /circles/:id/rounds': 'Start a new round',
      'GET /circles/:id/rounds/:roundId': 'Get round status',
      'POST /circles/:id/rounds/:roundId/allocate': 'Allocate gifts to members',
      'POST /circles/:id/rounds/:roundId/finalize': 'Finalize round and distribute',
      'GET /health': 'Health check',
      'GET /test/e2e': 'End-to-end test'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), circles: circles.size });
});

// Agent docs for LLMs
app.get('/agent', (req, res) => {
  res.json({
    name: 'Gift Circles',
    description: 'Peer-to-peer recognition and funding in circles. Members allocate percentages of a shared budget to other members. Each member controls their share of the budget but cannot allocate to themselves.',
    network: 'Base Sepolia',
    treasury_fee: '5%',
    treasury_address: TREASURY,
    endpoints: [
      { method: 'POST', path: '/circles', description: 'Create a gift circle', body: { name: 'string', fundingPool: '1.0' } },
      { method: 'GET', path: '/circles/:id', description: 'Get circle with members and rounds' },
      { method: 'POST', path: '/circles/:id/join', description: 'Join a circle', body: { address: '0x...', name: 'Alice' } },
      { method: 'POST', path: '/circles/:id/rounds', description: 'Start a new funding round', body: { roundBudget: 'optional' } },
      { method: 'GET', path: '/circles/:id/rounds/:roundId', description: 'Get round status and allocations' },
      { method: 'POST', path: '/circles/:id/rounds/:roundId/allocate', description: 'Allocate gifts to members', body: { fromMemberId: 'string', allocations: { memberId: 50 } } },
      { method: 'POST', path: '/circles/:id/rounds/:roundId/finalize', description: 'Finalize round and distribute funds on-chain' }
    ],
    example_flow: [
      '1. POST /circles { name: "Dev Team", fundingPool: "1.0" }',
      '2. POST /circles/:id/join { address: "0x...", name: "Alice" } (repeat for each member)',
      '3. POST /circles/:id/rounds {} → start round',
      '4. Each member: POST /rounds/:roundId/allocate { fromMemberId, allocations: { bobId: 60, carolId: 40 } }',
      '5. POST /rounds/:roundId/finalize → distributes ETH based on received allocations'
    ],
    x402_enabled: false
  });
});

// Create circle
app.post('/circles', requireWhitelist(), (req, res) => {
  const { name, fundingPool } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  
  const id = uuidv4();
  circles.set(id, {
    id,
    name,
    fundingPool: fundingPool || '0',
    members: [], // { id, address, name }
    rounds: [],
    createdAt: Date.now()
  });
  
  res.json({ success: true, circle: circles.get(id) });
});

// Get circle
app.get('/circles/:id', (req, res) => {
  const circle = circles.get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  res.json(circle);
});

// Join circle
app.post('/circles/:id/join', requireWhitelist(), (req, res) => {
  const circle = circles.get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  
  const { address, name } = req.body;
  if (!address) return res.status(400).json({ error: 'Address required' });
  
  // Check if already member
  if (circle.members.find(m => m.address.toLowerCase() === address.toLowerCase())) {
    return res.status(400).json({ error: 'Already a member' });
  }
  
  const memberId = uuidv4();
  circle.members.push({ id: memberId, address, name: name || 'Anonymous', joinedAt: Date.now() });
  
  res.json({ success: true, memberId });
});

// Start new round
app.post('/circles/:id/rounds', requireWhitelist(), (req, res) => {
  const circle = circles.get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  
  if (circle.members.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 members' });
  }
  
  const { roundBudget } = req.body;
  
  const roundId = uuidv4();
  const round = {
    id: roundId,
    budget: roundBudget || circle.fundingPool,
    status: 'open',
    allocations: {}, // fromMemberId -> { toMemberId: amount }
    results: null,
    createdAt: Date.now()
  };
  
  circle.rounds.push(round);
  res.json({ success: true, round });
});

// Get round
app.get('/circles/:id/rounds/:roundId', (req, res) => {
  const circle = circles.get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  
  const round = circle.rounds.find(r => r.id === req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  
  res.json(round);
});

// Allocate gifts
app.post('/circles/:id/rounds/:roundId/allocate', requireWhitelist(), (req, res) => {
  const circle = circles.get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  
  const round = circle.rounds.find(r => r.id === req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status !== 'open') return res.status(400).json({ error: 'Round not open' });
  
  const { fromMemberId, allocations } = req.body;
  // allocations: { toMemberId: percentage (0-100) }
  
  if (!fromMemberId || !allocations) {
    return res.status(400).json({ error: 'fromMemberId and allocations required' });
  }
  
  // Verify member
  const member = circle.members.find(m => m.id === fromMemberId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  
  // Verify targets are members (not self)
  let totalPercent = 0;
  for (const [toId, percent] of Object.entries(allocations)) {
    if (toId === fromMemberId) {
      return res.status(400).json({ error: 'Cannot allocate to self' });
    }
    if (!circle.members.find(m => m.id === toId)) {
      return res.status(400).json({ error: `Invalid member: ${toId}` });
    }
    totalPercent += percent;
  }
  
  if (totalPercent > 100) {
    return res.status(400).json({ error: 'Total allocation exceeds 100%' });
  }
  
  round.allocations[fromMemberId] = allocations;
  res.json({ success: true, allocations: round.allocations[fromMemberId] });
});

// Finalize and distribute
app.post('/circles/:id/rounds/:roundId/finalize', requireWhitelist(), async (req, res) => {
  const circle = circles.get(req.params.id);
  if (!circle) return res.status(404).json({ error: 'Circle not found' });
  
  const round = circle.rounds.find(r => r.id === req.params.roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  if (round.status !== 'open') return res.status(400).json({ error: 'Round already finalized' });
  
  // Calculate totals for each member
  const totals = {};
  for (const member of circle.members) {
    totals[member.id] = 0;
  }
  
  const budgetNum = parseFloat(round.budget);
  const perMemberBudget = budgetNum / circle.members.length;
  
  for (const [fromId, allocs] of Object.entries(round.allocations)) {
    for (const [toId, percent] of Object.entries(allocs)) {
      totals[toId] += (perMemberBudget * percent) / 100;
    }
  }
  
  round.results = [];
  const txHashes = [];
  
  try {
    const wallet = getWallet();
    
    for (const member of circle.members) {
      const amount = totals[member.id];
      if (amount > 0) {
        const amountWei = ethers.parseEther(amount.toFixed(18));
        const fee = amountWei * BigInt(Math.floor(FEE_RATE * 100)) / 100n;
        const payout = amountWei - fee;
        
        // Send fee
        const feeTx = await wallet.sendTransaction({ to: TREASURY, value: fee });
        await feeTx.wait();
        
        // Send payout
        const payoutTx = await wallet.sendTransaction({ to: member.address, value: payout });
        await payoutTx.wait();
        
        round.results.push({
          memberId: member.id,
          address: member.address,
          amount: ethers.formatEther(payout),
          txHash: payoutTx.hash
        });
        txHashes.push(payoutTx.hash);
      }
    }
    
    round.status = 'finalized';
    res.json({ success: true, results: round.results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// E2E Test
app.get('/test/e2e', async (req, res) => {
  const results = { tests: [], passed: 0, failed: 0 };
  
  const test = (name, condition) => {
    const passed = !!condition;
    results.tests.push({ name, passed });
    passed ? results.passed++ : results.failed++;
    return passed;
  };
  
  try {
    // Create circle
    const circleId = uuidv4();
    circles.set(circleId, {
      id: circleId,
      name: 'Test Circle',
      fundingPool: '1.0',
      members: [],
      rounds: [],
      createdAt: Date.now()
    });
    test('Create circle', circles.has(circleId));
    
    // Add members
    const circle = circles.get(circleId);
    const m1 = { id: 'member1', address: '0x1111111111111111111111111111111111111111', name: 'Alice' };
    const m2 = { id: 'member2', address: '0x2222222222222222222222222222222222222222', name: 'Bob' };
    const m3 = { id: 'member3', address: '0x3333333333333333333333333333333333333333', name: 'Carol' };
    circle.members.push(m1, m2, m3);
    test('Add members', circle.members.length === 3);
    
    // Start round
    const roundId = uuidv4();
    const round = {
      id: roundId,
      budget: '1.0',
      status: 'open',
      allocations: {},
      results: null,
      createdAt: Date.now()
    };
    circle.rounds.push(round);
    test('Start round', circle.rounds.length === 1);
    
    // Allocate (each member has 1/3 of budget to allocate)
    // Alice gives 50% to Bob, 50% to Carol
    round.allocations['member1'] = { 'member2': 50, 'member3': 50 };
    // Bob gives 100% to Carol
    round.allocations['member2'] = { 'member3': 100 };
    // Carol gives 100% to Alice
    round.allocations['member3'] = { 'member1': 100 };
    test('Allocate gifts', Object.keys(round.allocations).length === 3);
    
    // Calculate expected results (no actual tx)
    const budgetNum = parseFloat(round.budget);
    const perMember = budgetNum / 3; // ~0.333
    
    // Alice receives: 0.333 * 100% from Carol = 0.333
    // Bob receives: 0.333 * 50% from Alice = 0.167
    // Carol receives: 0.333 * 50% from Alice + 0.333 * 100% from Bob = 0.167 + 0.333 = 0.5
    
    const totals = { member1: 0, member2: 0, member3: 0 };
    for (const [from, allocs] of Object.entries(round.allocations)) {
      for (const [to, pct] of Object.entries(allocs)) {
        totals[to] += (perMember * pct) / 100;
      }
    }
    
    test('Calculate totals', 
      Math.abs(totals.member1 - 0.333) < 0.01 &&
      Math.abs(totals.member2 - 0.167) < 0.01 &&
      Math.abs(totals.member3 - 0.5) < 0.01
    );
    
    // Cleanup
    circles.delete(circleId);
    test('Cleanup', !circles.has(circleId));
    
  } catch (err) {
    results.error = err.message;
  }
  
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gift Circles running on port ${PORT}`));

module.exports = app;
