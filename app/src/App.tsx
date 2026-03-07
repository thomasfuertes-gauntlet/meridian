import { useMemo } from "react";
import { Routes, Route, Link, useLocation } from "react-router-dom";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

import { RPC_URL } from "./lib/constants";
import { LocalDevWalletAdapter } from "./lib/local-wallet";
import { WalletButton } from "./components/WalletButton";
import { Landing } from "./pages/Landing";
import { Markets } from "./pages/Markets";
import { Trade } from "./pages/Trade";
import { Portfolio } from "./pages/Portfolio";

function NavLink({ to, label }: { to: string; label: string }) {
  const { pathname } = useLocation();
  const active = pathname === to || pathname.startsWith(to + "/");
  return (
    <Link
      to={to}
      className={`text-sm transition-colors ${
        active ? "text-white" : "text-gray-500 hover:text-gray-300"
      }`}
    >
      {label}
    </Link>
  );
}

export default function App() {
  const isLocalhost = RPC_URL.includes("localhost") || RPC_URL.includes("127.0.0.1");
  const wallets = useMemo(
    () => (isLocalhost ? [new LocalDevWalletAdapter()] : []),
    [isLocalhost]
  );

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="min-h-screen flex flex-col">
            <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <div className="flex items-center gap-6">
                <Link to="/" className="text-xl font-bold text-green-400">
                  MERIDIAN
                </Link>
                <nav className="flex gap-4">
                  <NavLink to="/markets" label="Markets" />
                  <NavLink to="/portfolio" label="Portfolio" />
                </nav>
              </div>
              <WalletButton />
            </header>
            <main className="flex-1 px-6 py-6">
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/markets" element={<Markets />} />
                <Route path="/trade/:ticker" element={<Trade />} />
                <Route path="/portfolio" element={<Portfolio />} />
              </Routes>
            </main>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
