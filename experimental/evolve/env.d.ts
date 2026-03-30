/* eslint-disable */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "EvolveExampleAgent";
  }
  interface Env {
    AI: Ai;
    EvolveExampleAgent: DurableObjectNamespace<
      import("./src/server").EvolveExampleAgent
    >;
  }
}
interface Env extends Cloudflare.Env {}
