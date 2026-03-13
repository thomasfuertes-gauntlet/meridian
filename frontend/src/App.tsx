import { useMemo } from "react";
import { Route, Routes, Link, useLocation } from "react-router-dom";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SettlementCountdown } from "./components/SettlementCountdown";
import { IS_LOCAL_RPC, PROGRAM_ID, RPC_MODE_LABEL, RPC_URL } from "./lib/constants";
import { LocalDevWalletAdapter } from "./lib/local-wallet";
import { WalletButton } from "./components/WalletButton";
import { Landing } from "./pages/Landing";
import { Markets } from "./pages/Markets";
import { MarketDetail } from "./pages/MarketDetail";
import { Portfolio } from "./pages/Portfolio";
import { Activity } from "./pages/Activity";

function NavLink({ to, label }: { to: string; label: string }) {
  const { pathname } = useLocation();
  const active = pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Link to={to} aria-current={active ? "page" : undefined}>
      {label}
    </Link>
  );
}

export default function App() {
  const useDevWallet =
    IS_LOCAL_RPC || import.meta.env.VITE_DEV_WALLET === "true";
  const wallets = useMemo(
    () => (useDevWallet ? [new LocalDevWalletAdapter()] : []),
    [useDevWallet]
  );

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <header>
            <nav>
              <strong>Meridian</strong>
              <NavLink to="/" label="Overview" />
              <NavLink to="/markets" label="Markets" />
              <NavLink to="/activity" label="Activity" />
              <NavLink to="/portfolio" label="Portfolio" />
            </nav>
            <div>
              <small>{RPC_MODE_LABEL}</small>
              <small>{PROGRAM_ID.toBase58().slice(0, 8)}</small>
              <SettlementCountdown />
              <WalletButton />
            </div>
          </header>
          <main>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/markets/:ticker" element={<MarketDetail />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/portfolio" element={<Portfolio />} />
            </Routes>
          </main>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
