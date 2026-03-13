import { createContext } from "react";
import type {
  MarketUniverse,
} from "./market-data";

export interface MarketDataContextValue {
  data: MarketUniverse | null;
  error: string | null;
  loading: boolean;
}

export const MarketDataContext = createContext<MarketDataContextValue>({
  data: null,
  error: null,
  loading: true,
});
