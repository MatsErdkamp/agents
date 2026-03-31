export const BENCHMARK_FIXTURES = [
  {
    id: "arith-1",
    problem: "What is 2 + 2?",
    expectedAnswer: "4",
    focus: "addition"
  },
  {
    id: "arith-2",
    problem: "What is 5 + 7?",
    expectedAnswer: "12",
    focus: "addition"
  },
  {
    id: "arith-3",
    problem: "What is 12 - 5?",
    expectedAnswer: "7",
    focus: "subtraction"
  },
  {
    id: "arith-4",
    problem: "What is 9 + 8?",
    expectedAnswer: "17",
    focus: "addition"
  }
] as const;

export type BenchmarkFixture = (typeof BENCHMARK_FIXTURES)[number];
