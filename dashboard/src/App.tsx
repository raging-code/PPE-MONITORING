import Shell from './components/Shell.tsx';
import WearerSync from './components/WearerSync.tsx';
import { getRuntime } from './app/runtime.ts';
export default function App() {
  const rt = getRuntime();
  return <><WearerSync /><Shell controller={rt.controller} bridge={rt.bridge} silence={rt.bridge.silence} gate={rt.gate} /></>;
}
