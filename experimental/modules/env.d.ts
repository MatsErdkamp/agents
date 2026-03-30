/* eslint-disable */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "ModulesExampleAgent";
  }
  interface Env {
    AI: Ai;
    ModulesExampleAgent: DurableObjectNamespace<
      import("./src/server").ModulesExampleAgent
    >;
  }
}
interface Env extends Cloudflare.Env {}
