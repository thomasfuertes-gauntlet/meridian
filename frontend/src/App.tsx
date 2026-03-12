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
import { useMarketUniverse } from "./lib/market-data";

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

export default function App() {
  const useDevWallet =
    IS_LOCAL_RPC || import.meta.env.VITE_DEV_WALLET === "true";
  const wallets = useMemo(
    () => (useDevWallet ? [new LocalDevWalletAdapter()] : []),
    [useDevWallet]
  );
  const { data } = useMarketUniverse();
  const tickerTapeItems = data?.tickerSnapshots?.length
    ? data.tickerSnapshots
    : [
        "AAPL",
        "MSFT",
        "GOOGL",
        "AMZN",
        "NVDA",
        "META",
        "TSLA",
      ].map((ticker) => ({
        ticker,
        latestPrice: null,
      }));

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="min-h-screen bg-[#090b12] text-stone-100">
            <div className="border-b border-white/6 bg-[#06080d]">
              <div className="ticker-tape-viewport">
                <div className="ticker-tape-track text-xs text-stone-400">
                  {[0, 1].map((segment) => (
                    <div key={segment} className="ticker-tape-segment">
                      {tickerTapeItems.map((item, index) => (
                        <div key={`${segment}-${item.ticker}-${index}`} className="ticker-pill">
                          <span className="font-mono text-stone-200">{item.ticker}</span>
                          <span className="text-stone-500">
                            {item.latestPrice != null ? `$${item.latestPrice.toFixed(2)}` : "--"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mx-auto flex min-h-[calc(100vh-44px)] max-w-[1800px] gap-4 px-3 py-4 sm:px-6 lg:px-8">
              <aside className="terminal-panel sticky top-4 hidden h-fit w-[252px] shrink-0 p-4 lg:block">
                <div className="space-y-6">
                  <div className="space-y-3">
                    <div className="inline-flex items-center rounded-full border border-sky-400/15 bg-sky-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.28em] text-sky-200">
                      Desk Mode
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.35em] text-zinc-500">Tom Fuertes</p>
                      <h1 className="font-display text-3xl text-white">Meridian</h1>
                      <p className="mt-1 text-xs text-zinc-500">{RPC_MODE_LABEL}</p>
                    </div>
                    <p className="text-sm leading-6 text-zinc-400">
                      Trade live MAG7 close-above markets with on-chain books, oracle pricing, and direct wallet flow.
                    </p>
                  </div>

                  <nav className="space-y-2">
                    <NavLink to="/" label="Overview" />
                    <NavLink to="/markets" label="Markets" />
                    <NavLink to="/activity" label="Activity" />
                    <NavLink to="/portfolio" label="Portfolio" />
                  </nav>

                <div className="rounded-[22px] border border-white/8 bg-white/[0.03] p-4">
                  <div className="text-sm text-zinc-200">Runtime notes</div>
                  <p className="mt-3 text-sm leading-6 text-zinc-400">
                    Use `npm run dev` plus `frontend/.env.local` for local validator work. Point `VITE_RPC_URL` at devnet only when you intentionally want the shared remote environment.
                  </p>
                </div>
                </div>
              </aside>

              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <header className="terminal-panel terminal-panel--header flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-[0.35em] text-zinc-500">Session overview</p>
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="font-display text-3xl text-zinc-50">MAG7 close markets</h2>
                      <span className="rounded-full border border-emerald-400/15 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">
                        {IS_LOCAL_RPC ? "Local validator" : "Remote market feed"}
                      </span>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
                    <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">RPC mode</p>
                      <p className="font-data text-sm text-zinc-200">{RPC_MODE_LABEL}</p>
                    </div>
                    <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">Program</p>
                      <p className="font-data text-sm text-zinc-200">{PROGRAM_ID.toBase58().slice(0, 8)}</p>
                    </div>
                    {/* <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                      <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">Endpoint</p>
                      <p className="font-data text-sm text-zinc-200">{RPC_URL.slice(0, 18)}{RPC_URL.length > 18 ? "..." : ""}</p>
                    </div> */}
                    <div className="wallet-toolbar flex flex-wrap items-center gap-2">
                      <SettlementCountdown />
                      <WalletButton />
                    </div>
                  </div>
                </header>

                <nav className="terminal-panel flex items-center gap-2 overflow-x-auto p-2 lg:hidden">
                  <NavLink to="/" label="Overview" />
                  <NavLink to="/markets" label="Markets" />
                  <NavLink to="/activity" label="Activity" />
                  <NavLink to="/portfolio" label="Portfolio" />
                </nav>

                <main className="page-enter min-w-0 flex-1 pb-6">
                  <Routes>
                    <Route path="/" element={<Landing />} />
                    <Route path="/markets" element={<Markets />} />
                    <Route path="/markets/:ticker" element={<MarketDetail />} />
                    <Route path="/activity" element={<Activity />} />
                    <Route path="/portfolio" element={<Portfolio />} />
                  </Routes>
                </main>
              </div>
            </div>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
