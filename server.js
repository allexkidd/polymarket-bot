/**
 * POLYMARKET SNIPER BOT
 * Automatically trades 15-minute crypto markets when probability >= 95% and time <= 60s
 * 
 * SLUG FORMAT: {crypto}-updown-15m-{UTC_START_TIMESTAMP}
 * The timestamp is the START of the 15-minute window in UTC
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  PORT: process.env.PORT || 3000,
  CRYPTOS: ['btc', 'eth', 'sol', 'xrp'],
  GAMMA_API: 'https://gamma-api.polymarket.com',
  CLOB_API: 'https://clob.polymarket.com',
  CHAIN_ID: 137,
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  NEG_RISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  USDC_ADDRESS: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
};

// EIP-712 structures for signing
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' }
  ]
};

const CLOB_AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: CONFIG.CHAIN_ID
};

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' }
  ]
};

// ============================================
// BOT STATE
// ============================================

const botState = {
  isRunning: false,
  wallet: null,
  provider: null,
  apiCredentials: null,
  ethers: null,
  
  settings: {
    cryptos: [...CONFIG.CRYPTOS],
    probabilityThreshold: 0.95,
    timeThresholdSeconds: 60,
    tradeAmountUsdc: 10,
    pollIntervalMs: 2000,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || ''
  },
  
  tradedSlugs: new Set(),
  markets: [],
  trades: [],
  logs: [],
  stats: {
    totalTrades: 0,
    totalVolume: 0,
    startTime: null
  },
  
  intervalId: null,
  lastSuccessfulFetch: null,
  lastSlugTimestamp: null
};

// ============================================
// LOGGING
// ============================================

function addLog(message, type = 'info') {
  const entry = {
    timestamp: new Date().toISOString(),
    message,
    type,
    id: Date.now() + Math.random()
  };
  botState.logs.unshift(entry);
  if (botState.logs.length > 200) botState.logs.pop();
  console.log(`[${entry.timestamp}] [${type.toUpperCase()}] ${message}`);
  return entry;
}

// ============================================
// MARKET SLUG CALCULATION
// ============================================

function calculateCurrentSlugs() {
  const now = new Date();
  const currentTimestamp = Math.floor(now.getTime() / 1000);
  
  // Round DOWN to nearest 15-minute mark (900 seconds)
  // This gives us the START timestamp of the current window
  const startTimestamp = Math.floor(currentTimestamp / 900) * 900;
  
  // End timestamp is start + 15 minutes (900 seconds)
  const endTimestamp = startTimestamp + 900;
  
  // Time remaining until this window closes
  const timeToEnd = endTimestamp - currentTimestamp;
  
  // Generate slugs for all cryptos
  const slugs = botState.settings.cryptos.map(crypto => 
    `${crypto}-updown-15m-${startTimestamp}`
  );
  
  // Log when we switch to a new window
  if (startTimestamp !== botState.lastSlugTimestamp) {
    const startDate = new Date(startTimestamp * 1000);
    const endDate = new Date(endTimestamp * 1000);
    addLog(`New window: ${startDate.toISOString().slice(11,16)} - ${endDate.toISOString().slice(11,16)} UTC`, 'info');
    botState.lastSlugTimestamp = startTimestamp;
  }
  
  return { 
    slugs, 
    startTimestamp,
    endTimestamp,
    timeToEnd,
    currentTimestamp
  };
}

// ============================================
// TELEGRAM
// ============================================

async function sendTelegram(message) {
  const { telegramBotToken, telegramChatId } = botState.settings;
  if (!telegramBotToken || !telegramChatId) {
    return false;
  }
  
  try {
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    
    const result = await response.json();
    if (result.ok) {
      addLog('Telegram sent', 'success');
      return true;
    }
    addLog(`Telegram error: ${result.description}`, 'error');
    return false;
  } catch (error) {
    addLog(`Telegram failed: ${error.message}`, 'error');
    return false;
  }
}

// ============================================
// POLYMARKET API
// ============================================

async function fetchMarketData() {
  try {
    const { slugs, startTimestamp } = calculateCurrentSlugs();
    
    const slugParams = slugs.map(s => `slug=${encodeURIComponent(s)}`).join('&');
    const url = `${CONFIG.GAMMA_API}/events?${slugParams}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    botState.lastSuccessfulFetch = Date.now();
    
    if (data.length === 0) {
      addLog(`No markets found for timestamp ${startTimestamp}`, 'warning');
    }
    
    return data;
  } catch (error) {
    addLog(`API error: ${error.message}`, 'error');
    return null;
  }
}

function processMarkets(events) {
  if (!events || !Array.isArray(events)) return [];
  
  const now = Date.now();
  const processed = [];

  for (const event of events) {
    if (!event.markets?.length) continue;

    for (const market of event.markets) {
      try {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        const prices = JSON.parse(market.outcomePrices || '[]');
        if (tokenIds.length < 2 || prices.length < 2) continue;

        const endDateMs = new Date(market.endDate).getTime();
        const timeRemaining = (endDateMs - now) / 1000;
        
        // Skip markets that have already ended
        if (timeRemaining < -60) continue;
        
        const upPrice = parseFloat(prices[0]);
        const downPrice = parseFloat(prices[1]);
        const highProbSide = upPrice >= downPrice ? 'UP' : 'DOWN';
        const highProb = Math.max(upPrice, downPrice);

        processed.push({
          id: market.id,
          slug: event.slug,
          question: market.question || event.title,
          crypto: event.slug.split('-')[0].toUpperCase(),
          upTokenId: tokenIds[0],
          downTokenId: tokenIds[1],
          upPrice,
          downPrice,
          highProbSide,
          highProb,
          highProbTokenId: upPrice >= downPrice ? tokenIds[0] : tokenIds[1],
          timeRemaining,
          endDate: market.endDate,
          active: market.active && market.acceptingOrders,
          negRisk: event.negRisk || false
        });
      } catch (e) { /* skip */ }
    }
  }
  
  return processed;
}

// ============================================
// WALLET & TRADING
// ============================================

async function initializeWallet(privateKey) {
  if (!botState.ethers) {
    const { ethers } = require('ethers');
    botState.ethers = ethers;
  }
  
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  botState.wallet = new botState.ethers.Wallet(key);
  botState.provider = new botState.ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  
  addLog(`Wallet initialized: ${botState.wallet.address}`, 'success');
  
  // Get balances
  try {
    const maticBal = await botState.provider.getBalance(botState.wallet.address);
    const usdcContract = new botState.ethers.Contract(
      CONFIG.USDC_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      botState.provider
    );
    const usdcBal = await usdcContract.balanceOf(botState.wallet.address);
    
    return {
      address: botState.wallet.address,
      matic: botState.ethers.utils.formatEther(maticBal),
      usdc: botState.ethers.utils.formatUnits(usdcBal, 6)
    };
  } catch (e) {
    addLog(`Balance check failed: ${e.message}`, 'warning');
    return { address: botState.wallet.address, matic: '0', usdc: '0' };
  }
}

async function deriveApiCredentials() {
  if (!botState.wallet || !botState.ethers) throw new Error('Wallet not initialized');
  
  addLog('Deriving API credentials...');
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = 0;
  
  const value = {
    address: botState.wallet.address,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet'
  };
  
  const signature = await botState.wallet._signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, value);
  
  const response = await fetch(`${CONFIG.CLOB_API}/auth/derive-api-key`, {
    method: 'GET',
    headers: {
      'POLY_ADDRESS': botState.wallet.address,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE': nonce.toString()
    }
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API key derivation failed: ${text}`);
  }
  
  botState.apiCredentials = await response.json();
  addLog('API credentials derived', 'success');
}

function createL2Headers(method, path, body = null) {
  if (!botState.apiCredentials) throw new Error('No API credentials');
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  let message = timestamp + method + path;
  if (body) message += JSON.stringify(body);
  
  const hmac = crypto.createHmac('sha256', Buffer.from(botState.apiCredentials.secret, 'base64'));
  hmac.update(message);
  
  return {
    'POLY_ADDRESS': botState.wallet.address,
    'POLY_API_KEY': botState.apiCredentials.apiKey,
    'POLY_PASSPHRASE': botState.apiCredentials.passphrase,
    'POLY_SIGNATURE': hmac.digest('base64'),
    'POLY_TIMESTAMP': timestamp
  };
}

async function executeTrade(market) {
  if (!botState.wallet || !botState.apiCredentials) {
    addLog('Cannot trade: wallet or API not ready', 'error');
    return { success: false };
  }
  
  addLog(`🎯 EXECUTING: ${market.crypto} ${market.highProbSide} @ ${(market.highProb * 100).toFixed(1)}%`, 'trade');
  
  try {
    const sizeInShares = botState.settings.tradeAmountUsdc / market.highProb;
    const makerAmount = Math.floor(botState.settings.tradeAmountUsdc * 1e6);
    const takerAmount = Math.floor(sizeInShares * 1e6);
    
    const order = {
      salt: Date.now().toString() + Math.random().toString().slice(2, 8),
      maker: botState.wallet.address,
      signer: botState.wallet.address,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId: market.highProbTokenId,
      makerAmount: makerAmount.toString(),
      takerAmount: takerAmount.toString(),
      expiration: (Math.floor(Date.now() / 1000) + 300).toString(),
      nonce: '0',
      feeRateBps: '0',
      side: 0,
      signatureType: 0
    };
    
    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: CONFIG.CHAIN_ID,
      verifyingContract: market.negRisk ? CONFIG.NEG_RISK_CTF_EXCHANGE : CONFIG.CTF_EXCHANGE
    };
    
    const signature = await botState.wallet._signTypedData(domain, ORDER_TYPES, order);
    
    const signedOrder = {
      order: { ...order, signature },
      owner: botState.wallet.address,
      orderType: 'GTC'
    };
    
    // Submit order
    const path = '/order';
    const response = await fetch(`${CONFIG.CLOB_API}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...createL2Headers('POST', path, signedOrder)
      },
      body: JSON.stringify(signedOrder)
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(JSON.stringify(result));
    }
    
    const orderId = result.orderID || result.id || 'submitted';
    addLog(`✅ Order: ${orderId}`, 'success');
    
    const trade = {
      id: Date.now(),
      orderId,
      slug: market.slug,
      crypto: market.crypto,
      side: market.highProbSide,
      price: market.highProb,
      amount: botState.settings.tradeAmountUsdc,
      timeRemaining: market.timeRemaining,
      timestamp: new Date().toISOString()
    };
    
    botState.trades.unshift(trade);
    botState.stats.totalTrades++;
    botState.stats.totalVolume += botState.settings.tradeAmountUsdc;
    
    await sendTelegram(
      `🤖 <b>${market.crypto} Trade!</b>\n\n` +
      `🎯 ${market.highProbSide} @ ${(market.highProb * 100).toFixed(1)}%\n` +
      `💵 $${botState.settings.tradeAmountUsdc}\n` +
      `⏱ ${market.timeRemaining.toFixed(1)}s left\n` +
      `🔗 <code>${orderId}</code>`
    );
    
    return { success: true, orderId };
  } catch (error) {
    addLog(`❌ Trade failed: ${error.message}`, 'error');
    await sendTelegram(`❌ Trade Failed: ${market.crypto}\n${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============================================
// MAIN MONITORING LOOP
// ============================================

async function monitorMarkets() {
  if (!botState.isRunning) return;
  
  const events = await fetchMarketData();
  
  // Only update markets if we got valid data
  if (events !== null && Array.isArray(events)) {
    botState.markets = processMarkets(events);
  }
  
  // Update time remaining for existing markets
  const now = Date.now();
  botState.markets = botState.markets.map(m => ({
    ...m,
    timeRemaining: (new Date(m.endDate).getTime() - now) / 1000
  }));
  
  for (const market of botState.markets) {
    if (botState.tradedSlugs.has(market.slug)) continue;
    if (market.timeRemaining <= 0 || !market.active) continue;
    
    const meetsProb = market.highProb >= botState.settings.probabilityThreshold;
    const meetsTime = market.timeRemaining > 0 && market.timeRemaining <= botState.settings.timeThresholdSeconds;
    
    if (meetsProb && meetsTime) {
      addLog(`🚨 SIGNAL: ${market.crypto} ${market.highProbSide} @ ${(market.highProb * 100).toFixed(1)}%`, 'trade');
      
      if (botState.wallet && botState.apiCredentials) {
        const result = await executeTrade(market);
        if (result.success) {
          botState.tradedSlugs.add(market.slug);
        }
      } else {
        addLog('⚠️ Wallet not connected', 'warning');
      }
    }
  }
}

// ============================================
// API ROUTES
// ============================================

// Get state
app.get('/api/state', (req, res) => {
  const { slugs, timeToEnd, startTimestamp, endTimestamp } = calculateCurrentSlugs();
  
  // Update time remaining for each market
  const now = Date.now();
  const marketsWithUpdatedTime = botState.markets.map(m => ({
    ...m,
    timeRemaining: (new Date(m.endDate).getTime() - now) / 1000
  }));
  
  res.json({
    isRunning: botState.isRunning,
    walletAddress: botState.wallet?.address || null,
    hasApiCredentials: !!botState.apiCredentials,
    settings: botState.settings,
    markets: marketsWithUpdatedTime,
    trades: botState.trades.slice(0, 50),
    logs: botState.logs.slice(0, 100),
    tradedSlugs: Array.from(botState.tradedSlugs),
    stats: botState.stats,
    currentSlugs: slugs,
    timeToEnd,
    startTimestamp,
    endTimestamp,
    serverTime: new Date().toISOString(),
    lastSuccessfulFetch: botState.lastSuccessfulFetch
  });
});

// Connect wallet
app.post('/api/wallet/connect', async (req, res) => {
  try {
    const { privateKey } = req.body;
    if (!privateKey) return res.status(400).json({ error: 'Private key required' });
    
    const result = await initializeWallet(privateKey);
    
    try {
      await deriveApiCredentials();
    } catch (e) {
      addLog(`API credentials failed: ${e.message}`, 'warning');
    }
    
    res.json({
      success: true,
      address: result.address,
      balances: { matic: result.matic, usdc: result.usdc },
      hasApiCredentials: !!botState.apiCredentials
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update settings
app.post('/api/settings', (req, res) => {
  const { settings } = req.body;
  if (settings) {
    Object.assign(botState.settings, settings);
    addLog('Settings updated', 'success');
  }
  res.json({ success: true, settings: botState.settings });
});

// Start bot
app.post('/api/bot/start', async (req, res) => {
  if (botState.isRunning) return res.json({ success: true, message: 'Already running' });
  
  botState.isRunning = true;
  botState.stats.startTime = new Date().toISOString();
  addLog('🚀 Bot started', 'success');
  
  await sendTelegram(
    `🚀 <b>Bot Started</b>\n\n` +
    `👛 ${botState.wallet?.address || 'No wallet'}\n` +
    `📊 Cryptos: ${botState.settings.cryptos.join(', ').toUpperCase()}\n` +
    `⚙️ ≥${(botState.settings.probabilityThreshold * 100).toFixed(0)}% & ≤${botState.settings.timeThresholdSeconds}s`
  );
  
  // Initial fetch
  await monitorMarkets();
  
  botState.intervalId = setInterval(monitorMarkets, botState.settings.pollIntervalMs);
  
  res.json({ success: true });
});

// Stop bot
app.post('/api/bot/stop', async (req, res) => {
  botState.isRunning = false;
  if (botState.intervalId) {
    clearInterval(botState.intervalId);
    botState.intervalId = null;
  }
  addLog('🛑 Bot stopped', 'warning');
  await sendTelegram(`🛑 Bot Stopped\nTrades: ${botState.stats.totalTrades}`);
  res.json({ success: true });
});

// Reset traded slugs
app.post('/api/bot/reset', (req, res) => {
  botState.tradedSlugs.clear();
  addLog('🔄 Reset traded markets', 'warning');
  res.json({ success: true });
});

// Test telegram
app.post('/api/telegram/test', async (req, res) => {
  const success = await sendTelegram(`🧪 Test at ${new Date().toISOString()}`);
  res.json({ success });
});

// ============================================
// START SERVER
// ============================================

app.listen(CONFIG.PORT, () => {
  const { slugs, timeToEnd } = calculateCurrentSlugs();
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('       POLYMARKET SNIPER BOT                           ');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log(`  🌐 Server running on port ${CONFIG.PORT}`);
  console.log(`  📊 Current slugs: ${slugs[0]}`);
  console.log(`  ⏱  Time to window end: ${Math.floor(timeToEnd)}s`);
  console.log('');
});
