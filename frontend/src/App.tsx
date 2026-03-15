import { useEffect, useMemo, useState } from "react";
import { Route, Routes, Link, useLocation } from "react-router-dom";
import {
  ConnectionProvider,
  WalletProvider,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { SettlementCountdown } from "./components/SettlementCountdown";
import { CLUSTER_LABEL, IS_LOCAL_RPC, PROGRAM_ID, RPC_URL } from "./lib/constants";
import { LocalDevWalletAdapter } from "./lib/local-wallet";
import { MarketDataProvider } from "./lib/ws-market-data";
import { WalletButton } from "./components/WalletButton";
import { FaucetButton } from "./components/FaucetButton";
import { Landing } from "./pages/Landing";
import { Markets } from "./pages/Markets";
import { MarketDetail } from "./pages/MarketDetail";
import { Portfolio } from "./pages/Portfolio";
import { Docs } from "./pages/Docs";
import { ELI5 } from "./pages/ELI5";
import { History } from "./pages/History";

function NetworkBanner() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [zeroBalance, setZeroBalance] = useState(false);

  useEffect(() => {
    if (!publicKey || IS_LOCAL_RPC) return;
    let alive = true;
    connection.getBalance(publicKey).then(
      (bal) => { if (alive) setZeroBalance(bal === 0); },
      () => { if (alive) setZeroBalance(false); },
    );
    return () => { alive = false; };
  }, [publicKey, connection]);

  if (!zeroBalance) return null;
  return (
    <p style={{ background: "#422", padding: "0.5rem 1rem", margin: 0, textAlign: "center", fontSize: 13 }}>
      <mark data-tone="red">0 SOL on {CLUSTER_LABEL}.</mark>{" "}
      Switch Phantom to <strong>Devnet</strong> (Settings → Developer Settings → Solana Network).
    </p>
  );
}

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
          <MarketDataProvider>
          <header>
            <nav>
              <Link to="/"><strong>Meridian</strong></Link>
              <NavLink to="/markets" label="Markets" />
              <NavLink to="/history" label="History" />
              <NavLink to="/portfolio" label="Portfolio" />
              <NavLink to="/docs" label="Docs" />
              <NavLink to="/eli5" label="ELI5" />
            </nav>
            <div>
              <mark data-tone={IS_LOCAL_RPC ? "muted" : "blue"}>{CLUSTER_LABEL}</mark>
              <small>{PROGRAM_ID.toBase58().slice(0, 8)}</small>
              <SettlementCountdown />
              <FaucetButton />
              <WalletButton />
            </div>
          </header>
          <NetworkBanner />
          <main>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/markets" element={<Markets />} />
              <Route path="/markets/:ticker" element={<MarketDetail />} />
              <Route path="/history" element={<History />} />
              <Route path="/portfolio" element={<Portfolio />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="/eli5" element={<ELI5 />} />
            </Routes>
          </main>
          </MarketDataProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
