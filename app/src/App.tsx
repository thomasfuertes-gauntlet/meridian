import { useMemo } from "react";
import { Routes, Route } from "react-router-dom";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

import { DEVNET_RPC } from "./lib/constants";
import { WalletButton } from "./components/WalletButton";
import { Markets } from "./pages/Markets";
import { Trade } from "./pages/Trade";

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={DEVNET_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="min-h-screen flex flex-col">
            <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <a href="/" className="text-xl font-bold text-green-400">
                MERIDIAN
              </a>
              <WalletButton />
            </header>
            <main className="flex-1 px-6 py-6">
              <Routes>
                <Route path="/" element={<Markets />} />
                <Route path="/trade/:ticker" element={<Trade />} />
              </Routes>
            </main>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
