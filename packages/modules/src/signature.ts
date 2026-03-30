import { z } from "zod";

export interface Signature<
  I extends z.ZodTypeAny = z.ZodUnknown,
  O extends z.ZodTypeAny = z.ZodUnknown
> {
  readonly name: string;
  readonly input: I;
  readonly output: O;
  readonly instructions?: string;
  readonly inputFieldDescriptions: Readonly<Record<string, string>>;
  readonly outputFieldDescriptions: Readonly<Record<string, string>>;
}

export class SignatureBuilder<
  I extends z.ZodTypeAny = z.ZodUnknown,
  O extends z.ZodTypeAny = z.ZodUnknown
> implements Signature<I, O> {
  constructor(
    readonly name: string,
    readonly input: I,
    readonly output: O,
    readonly instructions?: string,
    readonly inputFieldDescriptions: Readonly<Record<string, string>> = {},
    readonly outputFieldDescriptions: Readonly<Record<string, string>> = {}
  ) {}

  withInput<NextInput extends z.ZodTypeAny>(
    input: NextInput
  ): SignatureBuilder<NextInput, O> {
    return new SignatureBuilder(
      this.name,
      input,
      this.output,
      this.instructions,
      this.inputFieldDescriptions,
      this.outputFieldDescriptions
    );
  }

  withOutput<NextOutput extends z.ZodTypeAny>(
    output: NextOutput
  ): SignatureBuilder<I, NextOutput> {
    return new SignatureBuilder(
      this.name,
      this.input,
      output,
      this.instructions,
      this.inputFieldDescriptions,
      this.outputFieldDescriptions
    );
  }

  withInstructions(instructions: string): SignatureBuilder<I, O> {
    return new SignatureBuilder(
      this.name,
      this.input,
      this.output,
      instructions,
      this.inputFieldDescriptions,
      this.outputFieldDescriptions
    );
  }

  withInputFieldDescriptions(
    descriptions: Record<string, string>
  ): SignatureBuilder<I, O> {
    return new SignatureBuilder(
      this.name,
      this.input,
      this.output,
      this.instructions,
      { ...descriptions },
      this.outputFieldDescriptions
    );
  }

  withOutputFieldDescriptions(
    descriptions: Record<string, string>
  ): SignatureBuilder<I, O> {
    return new SignatureBuilder(
      this.name,
      this.input,
      this.output,
      this.instructions,
      this.inputFieldDescriptions,
      { ...descriptions }
    );
  }

  describeInputField(
    path: string,
    description: string
  ): SignatureBuilder<I, O> {
    return this.withInputFieldDescriptions({
      ...this.inputFieldDescriptions,
      [path]: description
    });
  }

  describeOutputField(
    path: string,
    description: string
  ): SignatureBuilder<I, O> {
    return this.withOutputFieldDescriptions({
      ...this.outputFieldDescriptions,
      [path]: description
    });
  }
}

export function signature(name: string): SignatureBuilder {
  return new SignatureBuilder(name, z.unknown(), z.unknown());
}
