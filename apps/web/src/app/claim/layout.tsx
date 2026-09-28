import { WalletProvider } from "@/components/wallet/WalletProvider";

export default function WalletLayout({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
