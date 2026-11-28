// A rostered node never heard (3.7): a grey card with no level and no colour of a level. Before Start monitoring it also says NOT READY.
export default function NotConnectedCard({ alias, notReady, wearer = null }: { alias: string; notReady: boolean; wearer?: string | null }) {
  return (
    <div data-testid={`node-${alias}-none`} className="min-h-11 w-full rounded-card border-2 border-dashed border-stale-text bg-stale-fill p-3 text-stale-text">
      <span className="flex items-center gap-2 text-xl font-bold"><span aria-hidden="true">•</span><span>{alias}</span><span>Not connected</span></span>
      {wearer && <span className="block text-base">Worn by {wearer}</span>}
      {notReady && <span className="block text-base font-semibold">NOT READY</span>}
    </div>
  );
}
