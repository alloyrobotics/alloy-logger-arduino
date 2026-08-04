// flow-copy.js - role-specific framing for the four mission experience flows.
// Mission facts stay fixed. Roles change only the register and the decision framing.

const DEBUG_CARDS = {
  hobbyist: [
    { title: 'Telemetry alone', desc: 'Scroll through plots and line the moments up by hand.', time: '~1 day' },
    { title: 'Codex', desc: 'Write parsers and rebuild what happened from the raw logs.', time: 'Hours' },
    { title: 'Alloy', desc: 'Ask once, then jump straight to the proof.', time: '5 min' },
  ],
  engineer: [
    { title: 'Telemetry alone', desc: 'Scroll, align, replay, repeat.', time: '~1 day' },
    { title: 'Codex', desc: 'Write parsers and reconstruct the mission context.', time: 'Hours' },
    { title: 'Alloy', desc: 'Ask once, then jump straight to the proof.', time: '5 min' },
  ],
  lead: [
    { title: 'Telemetry alone', desc: 'Tie up an engineer with manual replay and correlation.', time: '~1 day' },
    { title: 'Codex', desc: 'Spend engineering time rebuilding the mission context.', time: 'Hours' },
    { title: 'Alloy', desc: 'Get the answer and proof before choosing the fix.', time: '5 min' },
  ],
  marketing: [
    { title: 'Telemetry alone', desc: 'Turn raw plots into a clear story by hand.', time: '~1 day' },
    { title: 'Codex', desc: 'Build scripts that connect the mission to the outcome.', time: 'Hours' },
    { title: 'Alloy', desc: 'Ask once, then show the outcome and its proof.', time: '5 min' },
  ],
};

function variant(role, missionIntro, failureIntro, firstQuestion, followUp) {
  return {
    missionIntro,
    failureIntro,
    debugCards: DEBUG_CARDS[role],
    firstQuestion,
    followUp,
  };
}

export const flowCopy = {
  arm6: {
    base: variant(
      'engineer',
      'The arm repeats the same taught transfer between two stations for 12 cycles. A healthy cycle establishes the expected joint load, path and grip timing.',
      'On cycle 9 the shoulder torque reaches its 12 Nm clamp and the payload drops during transfer. The replay isolates that cycle against the nominal moves.',
      'Why did the arm drop the payload?',
      'Show me the torque signals that prove it.',
    ),
    hobbyist: variant(
      'hobbyist',
      'The arm moves the same part between two stations over and over. The healthy loop shows what the joints and gripper should do.',
      'On cycle 9 the shoulder joint runs out of torque and the part slips from the gripper. The failed move is lined up with a working one.',
      'Why did the arm lose the payload?',
      'Show me where the arm runs out of torque.',
    ),
    engineer: variant(
      'engineer',
      'The arm repeats the same taught transfer between two stations for 12 cycles. A healthy cycle establishes the expected joint load, path and grip timing.',
      'On cycle 9 the shoulder torque reaches its 12 Nm clamp and the payload drops during transfer. The replay isolates that cycle against the nominal moves.',
      'Why did the arm drop the payload?',
      'Show me the torque signals that prove it.',
    ),
    lead: variant(
      'lead',
      'Twelve repeated transfers provide a stable baseline for cycle time, joint load and grip state.',
      'Cycle 9 drops the payload when J2 reaches its torque limit, turning a repeatable transfer into a quality and uptime risk.',
      'What caused the payload drop, and what should the team fix first?',
      'Show me the evidence behind that decision.',
    ),
    marketing: variant(
      'marketing',
      'The arm completes the same pick-and-place loop between two stations until one transfer breaks the pattern.',
      'The part drops on cycle 9 while the arm continues the place move. The contrast with the healthy loop makes the outcome clear.',
      'Why did the arm drop the part before the transfer finished?',
      'Show me the clearest proof of the failed transfer.',
    ),
  },

  drone: {
    base: variant(
      'engineer',
      'The quadcopter flies a 90-second lawnmower survey at 6 m altitude with fixed waypoints and no operator input. A healthy lane is the baseline.',
      "Motor 3's degrading bearing forces the controller to increase throttle until compensation runs out. The mission loses altitude and ends in a controlled failsafe descent.",
      'What went wrong on the survey flight?',
      'Show me the altitude signal that proves it.',
    ),
    hobbyist: variant(
      'hobbyist',
      'The drone flies steady lanes across the survey field at the same height. One healthy lane shows how the flight should look.',
      'Motor 3 gets harder to spin until the controller cannot make up the difference. The drone loses altitude and lands under failsafe control.',
      'Why did the drone lose altitude during the survey?',
      'Show me where the drone starts to drop.',
    ),
    engineer: variant(
      'engineer',
      'The quadcopter flies a 90-second lawnmower survey at 6 m altitude with fixed waypoints and no operator input. A healthy lane is the baseline.',
      "Motor 3's degrading bearing forces the controller to increase throttle until compensation runs out. The mission loses altitude and ends in a controlled failsafe descent.",
      'What went wrong on the survey flight?',
      'Show me the altitude signal that proves it.',
    ),
    lead: variant(
      'lead',
      'A fixed 90-second survey plan provides a clean baseline for flight stability, motor load and mission completion.',
      'Motor 3 reaches its compensation limit, the vehicle loses altitude and the survey ends in a failsafe descent. The next-flight decision is whether to service that motor path.',
      'What ended the survey mission, and what should we fix before the next flight?',
      'Show me the evidence behind the motor decision.',
    ),
    marketing: variant(
      'marketing',
      'The drone follows a repeatable survey pattern until one flight leg changes the outcome.',
      'The aircraft loses altitude after Motor 3 can no longer hold the plan, then completes a controlled failsafe landing.',
      'Why did the survey flight end in a failsafe landing?',
      'Show me the clearest proof of the flight outcome.',
    ),
  },

  ssl: {
    base: variant(
      'engineer',
      'The robots coordinate to score, block, and reset for the next play. This nominal loop is the baseline for fault isolation.',
      'Late in the window the kicker bank stops reaching full charge. The anomaly is isolated against the nominal replay.',
      "What is wrong with bot 8's kicker?",
      'Show me the kicker signal that proves it.',
    ),
    hobbyist: variant(
      'hobbyist',
      'The robots work together to score, block and get ready for the next play. The working loop gives us something clean to compare the fault against.',
      'Late in the window the modelled kicker bank no longer reaches full charge. A healthy part of the replay shows what changed.',
      "Why does bot 8's kicker stop charging properly?",
      'Show me where the charge falls short.',
    ),
    engineer: variant(
      'engineer',
      'The robots coordinate to score, block, and reset for the next play. This nominal loop is the baseline for fault isolation.',
      'Late in the window the kicker bank stops reaching full charge. The anomaly is isolated against the nominal replay.',
      "What is wrong with bot 8's kicker?",
      'Show me the kicker signal that proves it.',
    ),
    lead: variant(
      'lead',
      'The robots coordinate each play, then reset for the next decision. The nominal loop gives the team a baseline for isolating the kicker anomaly.',
      'Late in the window the modelled kicker bank falls short of full charge. The isolated replay shows the issue without attributing it to the real match outcome.',
      "What is failing in bot 8's kicker model, and what should the team inspect first?",
      'Show me the charge evidence behind that decision.',
    ),
    marketing: variant(
      'marketing',
      'The robots coordinate each play, from scoring chances to the next reset. The healthy loop makes the later change easy to see.',
      'Late in the replay the modelled kicker bank stops reaching full charge. The before-and-after outcome is clear against the nominal loop.',
      "Why does bot 8's modelled kicker charge fall short late in the replay?",
      'Show me the clearest proof of the charge outcome.',
    ),
  },

  donna: {
    base: variant(
      'engineer',
      'Donna, Jack and Rory replay the closing stretch of one match from three independently recorded onboard logs. A healthy passage shows all three robots upright and active.',
      "Jack falls near the foul line and returns to WALKING while Donna and Rory stay upright. The replay isolates Jack's fall on the shared mission clock.",
      'How many times did Jack fall, and did Donna or Rory fall too?',
      'Show me the IMU signals in that window.',
    ),
    hobbyist: variant(
      'hobbyist',
      'Donna, Jack and Rory are replayed from the logs each robot recorded onboard. A working passage shows all three walking in the same match window.',
      'Jack falls near the foul line, then gets back to walking. Donna and Rory do not fall in the window.',
      'How many times did Jack fall, and did the other robots fall?',
      'Show me where Jack falls in the replay.',
    ),
    engineer: variant(
      'engineer',
      'Donna, Jack and Rory replay the closing stretch of one match from three independently recorded onboard logs. A healthy passage shows all three robots upright and active.',
      "Jack falls near the foul line and returns to WALKING while Donna and Rory stay upright. The replay isolates Jack's fall on the shared mission clock.",
      'How many times did Jack fall, and did Donna or Rory fall too?',
      'Show me the IMU signals in that window.',
    ),
    lead: variant(
      'lead',
      'Three independently recorded onboard logs let the team compare Donna, Jack and Rory across the same match window.',
      "Jack's fall is isolated to one robot in this window while Donna and Rory stay upright. That distinction directs follow-up to Jack rather than the whole squad.",
      'How often did Jack fall, and is the issue isolated to one robot?',
      'Show me the evidence behind that team decision.',
    ),
    marketing: variant(
      'marketing',
      "One real match is replayed from Donna, Jack and Rory's onboard logs, with all three robots aligned on one timeline.",
      'Jack falls and recovers while Donna and Rory stay upright. The synchronized replay turns a team outcome into a clear individual moment.',
      'How many times did Jack fall, and did Donna or Rory go down too?',
      'Show me the clearest proof of that match outcome.',
    ),
  },
};

function copyCards(cards) {
  return cards.map((card) => ({ ...card }));
}

export function getFlowCopy(missionId, roleId) {
  const mission = flowCopy[missionId];
  if (!mission) return null;
  const selected = mission[roleId] || mission.base;
  return {
    missionIntro: selected.missionIntro,
    failureIntro: selected.failureIntro,
    debugCards: copyCards(selected.debugCards),
    firstQuestion: selected.firstQuestion,
    followUp: selected.followUp,
  };
}
