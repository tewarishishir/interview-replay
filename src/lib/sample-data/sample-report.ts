// Permission obtained from Beta Tester 09 to use this anonymized session publicly.

import type { Report } from "@/lib/llm/schema";
import type { InterviewRoundType } from "@/lib/db/schema";

export const SAMPLE_ROUND_TYPE: InterviewRoundType = "coding";

export const SAMPLE_TRANSCRIPT = {
  wordCount: 4847,
  durationSeconds: 2700,
} as const;

export const SAMPLE_REPORT: Report = {
  aiRead: {
    readinessScore: 68,
    paragraph:
      "You solved both problems correctly and your test-case walkthroughs are genuinely strong — that's real signal. The gap that matters most at staff level is that you waited for the interviewer to raise production concerns (stack depth, memory) before pivoting your approach on Q2, and you didn't articulate the hashmap trade-off on Q1 beyond 'there are better ways'. Proactively naming the risk ('recursion depth is O(h) on a skewed tree — I'd prefer iterative') and the trade-off ('hashmap costs O(n) space but buys us a single pass') are the two phrases you need to internalize before your next Meta interview. Everything else is polish.",
  },

  executiveSummary:
    "You completed both problems correctly and demonstrated solid fundamentals: good clarifying questions, clear narration of your approach, and accurate complexity analysis. The main gap is in solution exploration depth — you jumped to the optimal approach quickly on Q1 without fully articulating the trade-off, and on Q2 you needed interviewer nudging before landing on the iterative BFS approach and correctly structuring the queue payload. At a staff level, driving those design decisions proactively and without prompting is the expectation.",

  strengths: [
    {
      heading: "Active edge-case clarification before coding",
      detail:
        "On both problems you asked targeted clarifying questions before writing a single line of code. On Q1 you confirmed character set, special characters, and whether numbers/spaces were possible. On Q2 you confirmed digit-only node values and the empty-root edge case. This is exactly the right habit.",
      evidence: [
        {
          quote:
            "first thing I want to ask is is everything's going to be uh just lowercase letters right",
        },
        {
          quote:
            "would it be uh would the values of those nodes be from zero to nine or um is it also could also be like 12 exist as a node value",
        },
      ],
    },
    {
      heading: "Accurate complexity analysis throughout",
      detail:
        "You correctly identified O(n) time and O(n) space for both the hashmap Q1 solution and the BFS Q2 solution, and you justified the space bound on Q2 by reasoning about queue occupancy rather than just stating it.",
      evidence: [
        {
          quote:
            "it would be basically whatever the input size is um so it would be I believe it would be o of n for that",
        },
      ],
    },
    {
      heading: "Thorough, narrated test-case walkthrough",
      detail:
        "You walked through both solutions with concrete inputs step by step, tracking the queue state, digit accumulation, and final sum explicitly. This demonstrates you trust your own solution enough to verify it rather than declare it correct and stop.",
      evidence: [
        {
          quote:
            "so we then pop it so again this this gets removed um and our node is one current current sum is one",
        },
        {
          quote: "12 * 10 which would be 120 + 4 124 so 4 124 um continue",
        },
      ],
    },
    {
      heading: "Caught own bug mid-walkthrough without prompting",
      detail:
        "While tracing Q2 you noticed the right-child append line still referenced node.left.val instead of node.right.val and flagged it yourself before the interviewer needed to point it out. Self-correction mid-trace is a positive signal.",
      evidence: [
        {
          quote:
            "q.append node.write current sum times 10 plus no. left. Val um",
        },
      ],
    },
  ],

  improvements: [
    {
      heading: "Articulate trade-offs between approaches before choosing",
      detail:
        "On Q1 you briefly mentioned the naïve O(n²) approach, then immediately pivoted to the hashmap solution without explaining why the hashmap is better beyond 'there's definitely better ways'. At staff level the expectation is to name the trade-off axis explicitly: runtime, memory overhead, code complexity, readability. A one-sentence comparison ('the hashmap trades O(n) extra space for a single pass instead of a nested loop, which is the right call when n is large') would close this gap.",
      action:
        "In your next session, after proposing any second approach, force yourself to say one sentence that completes this template: 'I prefer approach B over approach A because [trade-off axis] even though it costs [downside].' Rehearse this phrase until it becomes automatic.",
      evidence: [
        {
          quote:
            "while that's the nice solution there's definitely better ways to do this um we can just use it by um by just using a hashmap",
        },
      ],
      rebuildEligible: false,
    },
    {
      heading: "Drive the iterative-vs-recursive decision yourself on tree problems",
      detail:
        "On Q2 you proposed recursion first and only pivoted to BFS after the interviewer explicitly raised the stack-overflow concern. You should proactively mention call-stack depth as a risk whenever you reach for DFS recursion on a tree, especially at staff level where production concerns are expected to be self-surfaced.",
      action:
        "Every time you propose a recursive tree solution, immediately add: 'One thing to flag — recursion depth is bounded by tree height, so if the tree is skewed or very deep we'd want an iterative version using an explicit stack or queue.' Practice saying this sentence after every recursive tree proposal in your next five mock sessions.",
      evidence: [
        {
          quote:
            "let's kind of assume that the tree can be really big and trying to recurse through it might um we might have memory issues yeah what's the alternative approach",
        },
      ],
      rebuildEligible: false,
    },
    {
      heading: "Pre-decide the queue payload structure before writing the BFS loop",
      detail:
        "You figured out the (node, current_sum) tuple design while narrating mid-code. That reasoning is correct but it came out hesitantly and only after you started writing. At staff level, state the queue payload design as a deliberate design decision before the first line of the loop body.",
      action:
        "Before writing any BFS loop, write a one-line comment in your editor such as `# queue stores (node, running_digit_number)` and say it out loud. This forces you to commit to the data structure design explicitly and signals clear intent to the interviewer.",
      evidence: [],
      rebuildEligible: false,
    },
    {
      heading: "Tighten complexity framing: use two variables when appropriate",
      detail:
        "On Q2 you said time complexity is 'O of whatever the diameter of the tree is' before correcting to O(n). The diameter comment introduced unnecessary ambiguity. More broadly, when a problem has two independent inputs (like Q1's input string and order string), use separate variable names (e.g. O(n + k)) rather than collapsing everything to O(n).",
      action:
        "After every complexity statement, ask yourself: 'Are there two independent inputs here? If so, do they both appear in my bound?' If yes, name them separately. Spend five minutes before your next mock reviewing how to express complexity for two-input string problems.",
      evidence: [
        {
          quote:
            "for time complexity it would be o of n because we're still iterating through well o of whatever the um diameter of the tree is",
        },
      ],
      rebuildEligible: false,
    },
  ],

  communicationSignals: {
    pace: {
      averageWordsPerMinute: 175,
      summary:
        "Brisk pace — make sure key points are landing, not getting rushed past. Your pace is generally acceptable but you narrate in long unbroken runs when tracing test cases, which can obscure the logical steps. Inserting brief pauses ('okay, now the queue looks like X — pause — next we pop and…') would help both you and the listener track state.",
    },
    fillerWords: {
      summary:
        "Filler density is moderate. The most frequent patterns are 'um', 'I guess', and false-start restarts. These cluster most heavily when you are mid-pivot — switching from recursion to BFS — which signals that the uncertainty is real and the fix is faster internalization of the iterative DFS/BFS decision, not just speech practice.",
      topOffenders: ["um", "I guess", "I mean"],
    },
    structure: {
      summary:
        "Your code structure is clean and your walkthrough follows the code top-to-bottom, which is the right pattern. The verbal explanation of the algorithm before coding is present but could be tighter — you sometimes start describing the implementation before finishing the high-level description, which forces the listener to hold two levels of abstraction simultaneously.",
    },
    presence: {
      summary:
        "You stayed composed throughout, including during the interviewer's push-back on the recursive approach. You engaged with the challenge rather than defending your original answer, which is good. The brief uncertainty around DFS vs BFS was visible but resolved quickly.",
    },
  },

  roundSpecific: {
    kind: "coding",
    problemFraming:
      "You asked clarifying questions on 2/2 problems. Q1: 3 clarifying questions (character set, special chars, numbers/spaces). Q2: 4 clarifying questions (digit-only node values, empty root, output spec, tree structure). Framing depth was consistent across both problems.",
    solutionExploration:
      "You proposed 2 approaches on Q1 (naive O(n²), hashmap) but did not name an alternative on Q2 before coding (only proposed recursive DFS, pivoted to iterative BFS only after interviewer prompt). Trade-off articulation present on 0/2 problems.",
    implementationHygiene:
      "You used helper functions with typed parameters, used a deque correctly, handled base cases before main loops, and narrated intent while coding. You did not write logical-step comments before code on either problem.",
    verification:
      "You traced 2 concrete examples through your Q1 code and 1 through Q2. You verified output matches expected on 2/2 problems. Caught 1 bug mid-walkthrough (right-child reference).",
    recoveryFromFeedback:
      "Interviewer pushed back 1 time (recursion depth concern on Q2). You acknowledged and pivoted within 30 seconds. Recovery was clean: you proposed iterative BFS as the alternative and reasoned through queue payload design before writing.",
  },

  questionsCovered: [
    {
      question: "Can you tell me a bit about yourself and what you've been working on?",
      confidence: "high",
      source: "transcript_inferred",
    },
    {
      question:
        "You are given two strings, input and order. Sort the characters in input based on the ordering defined in order. For example, input='abcca', order='cba' → output='ccbaa'.",
      confidence: "high",
      source: "candidate_confirmed",
    },
    {
      question:
        "Can you walk me through the brute-force approach before moving to the optimal solution?",
      confidence: "high",
      source: "transcript_inferred",
      evidenceQuote:
        "so the naive approach would be like for every character in order we just loop through input and collect matching chars",
    },
    {
      question: "What is the time and space complexity of your hashmap solution?",
      confidence: "high",
      source: "transcript_inferred",
      evidenceQuote:
        "it would be basically whatever the input size is um so it would be I believe it would be o of n for that",
    },
    {
      question: "Can you trace through your Q1 solution with the example input?",
      confidence: "high",
      source: "transcript_inferred",
    },
    {
      question:
        "Given the root of a binary tree, a path starting from the root until a leaf can form a number. For example (1)->(2)->(3) represents 123. Return the sum of all such paths.",
      confidence: "high",
      source: "candidate_confirmed",
    },
    {
      question:
        "What clarifying questions do you have about the binary tree problem before starting?",
      confidence: "high",
      source: "transcript_inferred",
      evidenceQuote:
        "would it be uh would the values of those nodes be from zero to nine or um is it also could also be like 12 exist as a node value",
    },
    {
      question: "What approach would you take — can you think of a recursive solution?",
      confidence: "high",
      source: "transcript_inferred",
    },
    {
      question:
        "What if the tree is very large and trying to recurse through it might cause memory issues — what's the alternative approach?",
      confidence: "high",
      source: "transcript_inferred",
      evidenceQuote:
        "let's kind of assume that the tree can be really big and trying to recurse through it might um we might have memory issues yeah what's the alternative approach",
    },
    {
      question: "Can you code up the iterative BFS solution?",
      confidence: "high",
      source: "transcript_inferred",
    },
    {
      question:
        "Can you walk me through your BFS solution with the example tree and tell me the time and space complexity?",
      confidence: "high",
      source: "transcript_inferred",
      evidenceQuote:
        "so we then pop it so again this this gets removed um and our node is one current current sum is one",
    },
  ],

  per_question_analytics: [
    {
      question_text:
        "Can you tell me a bit about yourself and what you've been working on?",
      duration_seconds: 90,
      question_type: "motivation",
      star_signals: {
        situation: "present",
        task: "weak",
        action: "present",
        result: "weak",
      },
      filler_per_minute: 5.3,
      i_count: 6,
      we_count: 2,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "You are given two strings, input and order. Sort the characters in input based on the ordering defined in order. For example, input='abcca', order='cba' → output='ccbaa'.",
      duration_seconds: 150,
      question_type: "clarification",
      star_signals: { situation: "na", task: "na", action: "na", result: "na" },
      filler_per_minute: 7.2,
      i_count: 4,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "Can you walk me through the brute-force approach before moving to the optimal solution?",
      duration_seconds: 120,
      question_type: "technical",
      star_signals: { situation: "na", task: "na", action: "present", result: "weak" },
      filler_per_minute: 6.5,
      i_count: 5,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "What is the time and space complexity of your hashmap solution?",
      duration_seconds: 150,
      question_type: "technical",
      star_signals: { situation: "na", task: "na", action: "present", result: "present" },
      filler_per_minute: 4.0,
      i_count: 3,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text: "Can you trace through your Q1 solution with the example input?",
      duration_seconds: 420,
      question_type: "technical",
      star_signals: { situation: "na", task: "na", action: "present", result: "present" },
      filler_per_minute: 8.6,
      i_count: 14,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "Given the root of a binary tree, a path starting from the root until a leaf can form a number. For example (1)->(2)->(3) represents 123. Return the sum of all such paths.",
      duration_seconds: 210,
      question_type: "clarification",
      star_signals: { situation: "na", task: "na", action: "na", result: "na" },
      filler_per_minute: 9.1,
      i_count: 7,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "What clarifying questions do you have about the binary tree problem before starting?",
      duration_seconds: 150,
      question_type: "clarification",
      star_signals: { situation: "na", task: "na", action: "na", result: "na" },
      filler_per_minute: 11.2,
      i_count: 3,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "What approach would you take — can you think of a recursive solution?",
      duration_seconds: 180,
      question_type: "technical",
      star_signals: { situation: "na", task: "na", action: "weak", result: "missing" },
      filler_per_minute: 12.7,
      i_count: 8,
      we_count: 1,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "What if the tree is very large and trying to recurse through it might cause memory issues — what's the alternative approach?",
      duration_seconds: 180,
      question_type: "technical",
      star_signals: { situation: "na", task: "na", action: "present", result: "weak" },
      filler_per_minute: 14.3,
      i_count: 6,
      we_count: 2,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text: "Can you code up the iterative BFS solution?",
      duration_seconds: 600,
      question_type: "technical",
      star_signals: { situation: "na", task: "na", action: "present", result: "present" },
      filler_per_minute: 7.8,
      i_count: 18,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
    {
      question_text:
        "Can you walk me through your BFS solution with the example tree and tell me the time and space complexity?",
      duration_seconds: 450,
      question_type: "technical",
      star_signals: { situation: "na", task: "na", action: "present", result: "present" },
      filler_per_minute: 9.3,
      i_count: 16,
      we_count: 0,
      profile_leverage: { status: "no_match" },
    },
  ],

  storyHighlights: [],
};
