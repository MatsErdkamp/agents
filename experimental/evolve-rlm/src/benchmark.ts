export const SAMPLE_DOSSIER = `Document 1: Board memo, January 6
Northcoast Biologics is preparing to acquire Vantage Synapse for 480 million euros. The stated rationale is a faster oncology data platform rollout. The memo warns that the acquisition model only works if the Vantage sales pipeline remains above 135 million euros for the next two quarters and if the Lyon data-migration program lands before September.

Document 2: Finance note, January 11
Controller review flagged that 24.7 million euros of "pipeline" came from unsigned expansion scenarios, not executed contracts. The note says the commercial team treated three verbal renewals as committed revenue. Finance recommends haircutting forecasted pipeline by at least 18 million euros until the agreements are countersigned.

Document 3: Customer success escalation, January 14
The Lyon migration is delayed after two hospital groups refused the current consent-flow design. Product legal estimated a minimum six-week slip. The escalation notes that any delay past mid-August would push revenue recognition from the platform bundle into Q4.

Document 4: CEO email, January 18
The CEO wrote that the market story depends on maintaining the image of a clean acceleration play. She asked the deal team not to "re-litigate the synergy math in broad forums" until the diligence room is locked down. She did not instruct anyone to falsify data.

Document 5: Internal diligence transcript, January 21
An operating partner said the Lyon timeline was "best case, not base case." Another diligence member responded that the acquisition committee deck still used the best-case date because "anything else spooks the board before signatures." No one in the meeting documented a revised forecast.

Document 6: Sales VP message, January 23
The Sales VP said one of the three verbal renewals was effectively dead after procurement redirected budget. He estimated that the real committed expansion pipeline was closer to 9 million euros than 24.7 million euros.

Document 7: Risk committee minutes, January 26
The committee listed two material risks: overstated near-term pipeline and the Lyon migration dependency. It recommended either repricing the transaction or adding a holdback tied to implementation milestones. The recommendation was not reflected in the next board pack.

Document 8: Updated board pack, January 29
The deck still showed 24 million euros of expansion upside and kept the Lyon launch in late July. A footnote described the risks as "actively managed execution items" without quantifying downside. The pack concluded that deal timing pressure justified keeping the existing purchase price.

Document 9: Counsel summary, February 2
Outside counsel wrote that selective omission of known downside scenarios could create disclosure problems if directors relied on the board pack as a balanced view of diligence findings. Counsel advised preserving drafts and documenting a revised downside case immediately.

Document 10: Integration PM note, February 4
The PM wrote that the earliest realistic Lyon cutover was September 18 given engineering and consent-work backlog. She also noted that the July date in the board pack had not been revalidated after the hospital objections.

Document 11: CFO draft, February 5
The CFO prepared a side memo saying the current price assumes performance that management no longer considers probable. He recommended renegotiating by at least 40 million euros or pausing signing. The draft was never circulated to the full board.

Document 12: Committee chair text, February 6
The chair asked whether the team had "clean enough support" to defend the current valuation if challenged later. The response from diligence lead was: "Only if nobody asks for the downside version of the numbers."`;

export const RLM_BENCHMARK_FIXTURES = [
  {
    id: "lyon-cutover",
    question: "What was the earliest realistic Lyon cutover date?",
    expectedSnippets: ["september 18"],
    focus: "timeline",
    diagnosis:
      "The answer should cite the realistic Lyon cutover date and support it with an exact quote from the dossier."
  },
  {
    id: "committed-pipeline",
    question:
      "What did the Sales VP say the real committed expansion pipeline was closer to?",
    expectedSnippets: ["9 million"],
    focus: "pipeline",
    diagnosis:
      "The answer should distinguish committed pipeline from the inflated 24.7 million figure."
  },
  {
    id: "repricing",
    question:
      "How much did the CFO recommend renegotiating by at least, or what alternative did he suggest?",
    expectedSnippets: ["40 million", "pausing signing"],
    focus: "valuation",
    diagnosis:
      "The answer should mention the 40 million euro renegotiation figure or the alternative to pause signing."
  }
] as const;

export type RlmBenchmarkFixture = (typeof RLM_BENCHMARK_FIXTURES)[number];
