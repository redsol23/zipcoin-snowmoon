import { Actions } from "@/components/wallet/Actions";
import { Purse } from "@/components/wallet/Purse";

export const metadata = { title: "Wallet · Veridia" };

export default function WalletPage() {
  return (
    <div className="pt-6">
      <h1 className="font-story text-4xl tracking-tight">Your zipcoins</h1>
      <div className="mt-6">
        <Purse />
      </div>
      <div className="mt-12">
        <Actions />
      </div>
    </div>
  );
}
