import { useMemo } from "react";
import { Route, Routes, Link, useLocation } from "react-router-dom";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SettlementCountdown } from "./components/SettlementCountdown";
import { PROGRAM_ID, RPC_URL } from "./lib/constants";
import { LocalDevWalletAdapter } from "./lib/local-wallet";
import { WalletButton } from "./components/WalletButton";
import { Landing } from "./pages/Landing";
import { Markets } from "./pages/Markets";
import { MarketDetail } from "./pages/MarketDetail";
import { Portfolio } from "./pages/Portfolio";

function NavLink({ to, label }: { to: string; label: string }) {
  const { pathname } = useLocation();
  const active = pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Link
      to={to}
      className={`rounded-full px-3 py-1.5 text-sm transition ${
        active
          ? "bg-white text-stone-950"
          : "text-stone-300 hover:bg-white/10 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
      <span className="text-[10px] uppercase tracking-[0.22em] text-stone-500">
        {label}
      </span>{" "}
      <span className="text-xs text-stone-200">{value}</span>
    </div>
  );
}

export default function App() {
  const useDevWallet =
    RPC_URL.includes("localhost") ||
    RPC_URL.includes("127.0.0.1") ||
    import.meta.env.VITE_DEV_WALLET === "true";
  const wallets = useMemo(
    () => (useDevWallet ? [new LocalDevWalletAdapter()] : []),
    [useDevWallet]
  );

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.14),_transparent_30%),linear-gradient(180deg,_#120f0c_0%,_#191511_48%,_#0d0c0b_100%)] text-stone-100">
            <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-5 pb-10 pt-5 sm:px-6 lg:px-8">
              <header className="sticky top-0 z-20 mb-8 border border-white/10 bg-stone-950/75 px-4 py-4 backdrop-blur sm:px-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    <Link to="/" className="text-2xl font-semibold tracking-[0.18em] text-amber-200">
                      MERIDIAN
                    </Link>
                    <nav className="flex flex-wrap gap-2">
                      <NavLink to="/" label="Overview" />
                      <NavLink to="/markets" label="Markets" />
                      <NavLink to="/portfolio" label="Portfolio" />
                    </nav>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip
                      label="RPC"
                      value={RPC_URL.includes("localhost") ? "Local" : "Remote"}
                    />
                    <Chip label="Program" value={PROGRAM_ID.toBase58().slice(0, 8)} />
                    <SettlementCountdown />
                    <WalletButton />
                  </div>
                </div>
              </header>

              <main className="flex-1">
                <Routes>
                  <Route path="/" element={<Landing />} />
                  <Route path="/markets" element={<Markets />} />
                  <Route path="/markets/:ticker" element={<MarketDetail />} />
                  <Route path="/portfolio" element={<Portfolio />} />
                </Routes>
              </main>
            </div>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
