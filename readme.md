# Polymarket Sniper Bot

Automated trading bot for Polymarket 15-minute crypto markets.

## Features

- Auto-discovers current 15-minute markets (BTC, ETH, SOL, XRP)
- Trades when probability >= 95% AND time remaining <= 60 seconds
- Each market only traded once
- Telegram notifications
- Web interface to control the bot

## Deployment

This bot is designed to run on Fly.io.

## Settings

- **Probability Threshold:** 95% (default)
- **Time Threshold:** 60 seconds (default)
- **Trade Amount:** $10 USDC (default)
- **Cryptos:** BTC, ETH, SOL, XRP (default)
