// Full-screen red state (design 3.7). The repeating tone and the Web Worker judgement are P22c.
export default function NoLiveData() {
  return (
    <div role="alert" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-level-danger p-8 text-center text-white">
      <p className="text-3xl font-bold">NO LIVE DATA: responders are NOT being monitored</p>
      <p className="text-xl">Reconnecting to the host. Use the radio until this message clears.</p>
    </div>
  );
}
