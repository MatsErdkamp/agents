import { z } from "zod";

export interface Signature<
  I extends z.ZodTypeAny = z.ZodUnknown,
  O extends z.ZodTypeAny = z.ZodUnknown
> {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  readonly instructions?: string;
}

export class SignatureBuilder<
  I extends z.ZodTypeAny = z.ZodUnknown,
  O extends z.ZodTypeAny = z.ZodUnknown
> implements Signature<I, O> {
  constructor(
    readonly name: string,
    readonly input: I,
    readonly output: O,
    readonly instructions?: string
  ) {}

  withInput<NextInput extends z.ZodTypeAny>(
    input: NextInput
  ): SignatureBuilder<NextInput, O> {
    return new SignatureBuilder(
      this.name,
      input,
      this.output,
      this.instructions
    );
  }

  withOutput<NextOutput extends z.ZodTypeAny>(
    output: NextOutput
  ): SignatureBuilder<I, NextOutput> {
    return new SignatureBuilder(
      this.name,
      this.input,
      output,
      this.instructions
    );
  }

  withInstructions(instructions: string): SignatureBuilder<I, O> {
    return new SignatureBuilder(
      this.name,
      this.input,
      this.output,
      instructions
    );
  }
}

export function signature(name: string): SignatureBuilder {
  return new SignatureBuilder(name, z.unknown(), z.unknown());
}
