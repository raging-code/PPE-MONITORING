import Shell from './components/Shell.tsx';
import { getRuntime } from './app/runtime.ts';
export default function App() {
  const rt = getRuntime();
  return <Shell controller={rt.controller} bridge={rt.bridge} silence={rt.bridge.silence} />;
}
