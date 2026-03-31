/* eslint-disable */
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "EvolveRlmAgent";
  }
  interface Env {
    AI: Ai;
    LOADER: WorkerLoader;
    RLM_ARTIFACTS: R2Bucket;
    EvolveRlmAgent: DurableObjectNamespace<
      import("./src/server").EvolveRlmAgent
    >;
  }
}
interface Env extends Cloudflare.Env {}
