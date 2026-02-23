import express from "express";
import { createServer as createViteServer } from "vite";
import ccxt from "ccxt";
import axios from "axios";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  console.log("[Server] Starting with environment variables:");
  console.log("- MORALIS_API_KEY:", process.env.MORALIS_API_KEY ? "Present" : "Missing");
  console.log("- HELIUS_API_KEY:", process.env.HELIUS_API_KEY ? "Present" : "Missing");
  console.log("- ONEINCH_API_KEY:", process.env.ONEINCH_API_KEY ? "Present" : "Missing");
  console.log("- BINANCE_API_KEY:", process.env.BINANCE_API_KEY ? "Present" : "Missing");

  app.use(express.json());

  // --- SECURITY AUDIT: API ENDPOINTS ---
  // 1. All external API calls (CCXT, 1inch) are performed server-side to protect API keys.
  // 2. Input validation is required for symbol, chainId, and addresses to prevent injection.
  // 3. Rate limiting should be implemented to prevent DDoS on the bridge.
  // 4. No private keys are ever stored or handled by this server (Non-custodial).

  app.get("/api/debug/keys", (req, res) => {
    res.json({
      moralis: !!process.env.MORALIS_API_KEY,
      helius: !!process.env.HELIUS_API_KEY,
      oneinch: !!process.env.ONEINCH_API_KEY,
      binance: !!process.env.BINANCE_API_KEY,
      moralis_length: process.env.MORALIS_API_KEY?.length || 0
    });
  });

  // 1. CEX Price Fetcher
  app.get("/api/prices/cex", async (req, res) => {
    try {
      const { symbol = "BTC/USDT" } = req.query;
      // Security: Validate symbol format
      if (typeof symbol !== 'string' || !/^[A-Z0-9]+\/[A-Z0-9]+$/.test(symbol)) {
        return res.status(400).json({ error: "Invalid symbol format" });
      }

      const binance = new ccxt.binance();
      const ticker = await binance.fetchTicker(symbol);
      
      res.json({
        exchange: "Binance",
        symbol: ticker.symbol,
        bid: ticker.bid,
        ask: ticker.ask,
        last: ticker.last,
        timestamp: ticker.timestamp
      });
    } catch (error: any) {
      console.error("CEX Fetch Error:", error.message);
      res.status(500).json({ error: "Failed to fetch CEX prices" });
    }
  });

  // 2. DEX Price Fetcher (1inch & Odos)
  app.get("/api/prices/dex", async (req, res) => {
    try {
      const { chainId = "1", fromToken, toToken, amount } = req.query;
      const oneInchKey = process.env.ONEINCH_API_KEY;
      
      const results: any = {};

      // 1inch Quote (Optimized)
      if (oneInchKey) {
        try {
          const response = await axios.get(
            `https://api.1inch.dev/swap/v6.0/${chainId}/quote`,
            {
              params: { 
                fromTokenAddress: fromToken, 
                toTokenAddress: toToken, 
                amount,
                protocols: "PANCAKESWAP_V3,APESWAP,UNISWAP_V3,CURVE",
                complexityLevel: 3,
                gasPrice: "1000000000"
              },
              headers: { Authorization: `Bearer ${oneInchKey}` }
            }
          );
          results.oneinch = response.data;

          // Baseline: PancakeSwap Only for comparison
          const baselineRes = await axios.get(
            `https://api.1inch.dev/swap/v6.0/${chainId}/quote`,
            {
              params: { 
                fromTokenAddress: fromToken, 
                toTokenAddress: toToken, 
                amount,
                protocols: "PANCAKESWAP_V3", // Standard execution baseline
                complexityLevel: 1
              },
              headers: { Authorization: `Bearer ${oneInchKey}` }
            }
          );
          results.baseline = baselineRes.data;
        } catch (e) {
          console.error("1inch Quote Error");
        }
      }

      // Odos Quote V2/V3
      try {
        // Normalize native token for Odos
        const odosFromToken = fromToken === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' 
          ? '0x0000000000000000000000000000000000000000' 
          : fromToken;
        const odosToToken = toToken === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' 
          ? '0x0000000000000000000000000000000000000000' 
          : toToken;

        const odosPayload = {
          chainId: parseInt(chainId as string),
          inputTokens: [{ 
            tokenAddress: odosFromToken as string, 
            amount: amount as string 
          }],
          outputTokens: [{ 
            tokenAddress: odosToToken as string, 
            proportion: 1 
          }],
          userAddr: "0x0000000000000000000000000000000000000000",
          slippageLimitPercent: 0.5,
          compact: true,
          referralCode: 0
        };

        const odosResponse = await axios.post(
          `https://api.odos.xyz/sor/quote/v2`,
          odosPayload
        );
        results.odos = odosResponse.data;
      } catch (e: any) {
        console.error("Odos Quote Error:", e.response?.data || e.message);
      }

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 3. Token Tax Detection (Safety Module)
  app.get("/api/token/tax", async (req, res) => {
    try {
      const { chainId, tokenAddress } = req.query;
      if (chainId !== "56") {
        return res.json({ tax: 0, message: "Tax detection only enabled for BSC" });
      }

      const rpcUrl = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      
      // Minimal ERC20 ABI for simulation
      const abi = [
        "function balanceOf(address) view returns (uint256)",
        "function transfer(address, uint256) returns (bool)"
      ];
      
      const tokenContract = new ethers.Contract(tokenAddress as string, abi, provider);
      
      // Simulation: We use a static call to simulate a transfer from a known address
      // For a real production app, we would use a specialized "Tax Checker" contract
      // Here we simulate the logic: 
      // 1. Get balance of a test address
      // 2. Simulate transfer
      // 3. Check received amount
      
      // Mocking the result for the demo/prototype as full simulation requires a specific sender with balance
      // In production, this would be a call to a deployed TaxChecker contract.
      const mockTax = Math.random() > 0.8 ? 5 : 0; // 20% chance of 5% tax for demo
      
      res.json({ 
        tax: mockTax, 
        slippage: mockTax + 0.5,
        safety: mockTax > 10 ? "High Risk" : "Safe"
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 4. Multi-chain Balance Scanner (Real implementation using Moralis & Helius)

  // 3. Multi-chain Balance Scanner (Real implementation using Moralis & Helius)
  app.get("/api/balances", async (req, res) => {
    try {
      const { address, chains, tokenAddress } = req.query;
      const moralisKey = process.env.MORALIS_API_KEY?.trim();
      const heliusKey = process.env.HELIUS_API_KEY?.trim();

      if (!address) return res.status(400).json({ error: "Address is required" });
      console.log(`[Balance Scanner] Request for address: ${address}, chains: ${chains}`);

      const chainMap: Record<string, string> = {
        "eth": "0x1",
        "bsc": "0x38",
        "polygon": "0x89",
        "base": "0x2105"
      };

      const balances: any[] = [];

      // If a specific token address is provided, fetch just that one (BSC default for manual add)
      if (tokenAddress) {
        try {
          const rpcUrl = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const abi = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
          const contract = new ethers.Contract(tokenAddress as string, abi, provider);
          
          const [balance, symbol, decimals] = await Promise.all([
            contract.balanceOf(address),
            contract.symbol().catch(() => "TOKEN"),
            contract.decimals().catch(() => 18)
          ]);

          if (balance > 0n) {
            balances.push({
              chain: "BSC",
              symbol: symbol,
              amount: ethers.formatUnits(balance, decimals),
              valueUsd: 0,
              tokenAddress: tokenAddress
            });
          }
          return res.json({ address, balances });
        } catch (e) {
          console.error("Error fetching specific token:", e);
          // Fall through to general scan if specific fetch fails
        }
      }

      // Fetch EVM Balances
      if (moralisKey) {
        console.log(`Scanning EVM balances for ${address} via Moralis...`);
        const evmChains = (chains as string || "eth,bsc,polygon").split(",");
        for (const c of evmChains) {
          const chainId = chainMap[c.toLowerCase()];
          if (!chainId) continue;

          try {
            const response = await axios.get(
              `https://deep-index.moralis.io/api/v2.2/${address}/erc20`,
              {
                params: { chain: chainId },
                headers: { "X-API-Key": moralisKey }
              }
            );
            
            // Add native balance too
            const nativeResponse = await axios.get(
              `https://deep-index.moralis.io/api/v2.2/${address}/balance`,
              {
                params: { chain: chainId },
                headers: { "X-API-Key": moralisKey }
              }
            );

            balances.push({
              chain: c.toUpperCase(),
              symbol: c.toUpperCase() === "ETH" ? "ETH" : c.toUpperCase() === "BSC" ? "BNB" : "MATIC",
              amount: ethers.formatEther(nativeResponse.data.balance),
              valueUsd: 0,
              isNative: true
            });

            response.data.forEach((token: any) => {
              const balance = BigInt(token.balance || 0);
              if (balance > 0n) {
                balances.push({
                  chain: c.toUpperCase(),
                  symbol: token.symbol,
                  amount: ethers.formatUnits(balance, token.decimals),
                  decimals: token.decimals,
                  valueUsd: 0,
                  tokenAddress: token.token_address
                });
              }
            });
          } catch (e) {
            console.error(`Error fetching ${c} balances via Moralis:`, e);
          }
        }
      } else {
        // Fallback: Basic RPC Scan for BSC (Most common for Trust Wallet users)
        console.log(`No Moralis key, falling back to BSC RPC scan for ${address}...`);
        try {
          const bscRpc = process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
          const provider = new ethers.JsonRpcProvider(bscRpc);
          
          // 1. Native BNB
          const nativeBalance = await provider.getBalance(address as string);
          if (nativeBalance > 0n) {
            balances.push({
              chain: "BSC",
              symbol: "BNB",
              amount: ethers.formatEther(nativeBalance),
              decimals: 18,
              valueUsd: 0,
              isNative: true
            });
          }

          // 2. Common Tokens (USDT on BSC)
          const commonTokens = [
            { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT" },
            { address: "0xe9e7cea3dedca5984780bafc599bd69add087d56", symbol: "BUSD" }
          ];

          const abi = ["function balanceOf(address) view returns (uint256)"];
          for (const token of commonTokens) {
            const contract = new ethers.Contract(token.address, abi, provider);
            const balance = await contract.balanceOf(address);
            if (balance > 0n) {
              balances.push({
                chain: "BSC",
                symbol: token.symbol,
                amount: ethers.formatUnits(balance, 18),
                decimals: 18,
                valueUsd: 0,
                tokenAddress: token.address
              });
            }
          }
        } catch (e) {
          console.error("RPC Fallback Error:", e);
        }
      }

      // Fetch Solana Balances via Helius
      if (heliusKey && (chains as string || "").includes("solana")) {
        try {
          const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
            {
              jsonrpc: "2.0",
              id: "my-id",
              method: "getAssetsByOwner",
              params: {
                ownerAddress: address,
                page: 1,
                limit: 1000,
                displayOptions: { showFungible: true }
              }
            }
          );
          
          if (response.data && response.data.result && response.data.result.items) {
            response.data.result.items.forEach((item: any) => {
              if (item.token_info) {
                const balance = BigInt(item.token_info.balance || 0);
                if (balance > 0n) {
                  const decimals = item.token_info.decimals || 0;
                  balances.push({
                    chain: "SOLANA",
                    symbol: item.token_info.symbol,
                    amount: ethers.formatUnits(balance, decimals),
                    decimals: decimals,
                    valueUsd: 0,
                    tokenAddress: item.id
                  });
                }
              }
            });
          }
        } catch (e) {
          console.error("Error fetching Solana balances:", e);
        }
      }

      res.json({ address, balances });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // 4. 1inch Swap Data (For frontend signing)
  app.get("/api/swap/1inch", async (req, res) => {
    try {
      const { chainId, fromToken, toToken, amount, fromAddress, receiver, slippage = "1", fusion } = req.query;
      const apiKey = process.env.ONEINCH_API_KEY;

      if (!apiKey) return res.status(400).json({ error: "ONEINCH_API_KEY missing" });

      const response = await axios.get(
        `https://api.1inch.dev/swap/v6.0/${chainId}/swap`,
        {
          params: {
            src: fromToken,
            dst: toToken,
            amount,
            from: fromAddress,
            receiver: receiver || fromAddress, 
            slippage,
            disableEstimate: true,
            protocols: "PANCAKESWAP_V3,APESWAP,UNISWAP_V3,CURVE",
            complexityLevel: 3, // Pro Optimization: Maximize routing search
            parts: 50 // Pro Optimization: Split trade for concentrated liquidity
          },
          headers: { Authorization: `Bearer ${apiKey}` }
        }
      );

      res.json(response.data);
    } catch (error: any) {
      res.status(500).json({ error: error.response?.data || error.message });
    }
  });

  // 5. Odos Swap Data V3
  app.get("/api/swap/odos", async (req, res) => {
    try {
      const { chainId, fromToken, toToken, amount, fromAddress, receiver, slippage = "0.5" } = req.query;
      
      // 1. Get Quote V3
      const quoteRes = await axios.post(`https://api.odos.xyz/sor/quote/v3`, {
        chainId: parseInt(chainId as string),
        inputTokens: [{ tokenAddress: fromToken, amount: amount }],
        outputTokens: [{ tokenAddress: toToken, proportion: 1 }],
        userAddr: fromAddress,
        slippageLimitPercent: parseFloat(slippage as string),
        compact: true
      });

      // 2. Assemble Transaction V3
      const assembleRes = await axios.post(`https://api.odos.xyz/sor/assemble`, {
        userAddr: fromAddress,
        pathId: quoteRes.data.pathId,
        receiver: receiver || fromAddress
      });

      res.json(assembleRes.data);
    } catch (error: any) {
      res.status(500).json({ error: error.response?.data || error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
