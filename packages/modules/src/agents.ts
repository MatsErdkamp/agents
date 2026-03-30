import type { Agent, SubAgentClass, SubAgentStub } from "agents";
import type { RLMQueryOptions, RLMQueryProvider } from "./rlm-types";

export interface RLMSubAgentQueryRequest {
  prompt: string;
  options?: RLMQueryOptions;
}

export interface CreateSubAgentQueryProviderOptions<
  T extends Agent & {
    query(input: RLMSubAgentQueryRequest): Promise<string>;
  }
> {
  parent: {
    subAgent(cls: SubAgentClass<T>, name: string): Promise<SubAgentStub<T>>;
  };
  childClass: SubAgentClass<T>;
  naming?: (input: {
    prompt: string;
    index: number;
    batched: boolean;
    options?: RLMQueryOptions;
  }) => string;
}

export function createSubAgentQueryProvider<
  T extends Agent & {
    query(input: RLMSubAgentQueryRequest): Promise<string>;
  }
>(options: CreateSubAgentQueryProviderOptions<T>): RLMQueryProvider {
  const naming =
    options.naming ??
    ((input: { prompt: string; index: number; batched: boolean }): string => {
      const digest = shortHash(input.prompt);
      return input.batched
        ? `rlm-batch-${input.index}-${digest}`
        : `rlm-query-${digest}`;
    });

  return {
    async query(prompt, queryOptions) {
      const stub = (await options.parent.subAgent(
        options.childClass,
        naming({
          prompt,
          index: 0,
          batched: false,
          options: queryOptions
        })
      )) as SubAgentStub<T> & {
        query(input: RLMSubAgentQueryRequest): Promise<string>;
      };
      return stub.query({ prompt, options: queryOptions });
    },
    async batch(prompts, queryOptions) {
      const responses = await Promise.all(
        prompts.map(async (prompt, index) => {
          const stub = (await options.parent.subAgent(
            options.childClass,
            naming({
              prompt,
              index,
              batched: true,
              options: queryOptions
            })
          )) as SubAgentStub<T> & {
            query(input: RLMSubAgentQueryRequest): Promise<string>;
          };
          return stub.query({ prompt, options: queryOptions });
        })
      );
      return responses;
    }
  };
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
