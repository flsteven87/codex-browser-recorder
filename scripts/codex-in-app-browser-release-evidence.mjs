const EVIDENCE_TIMEOUT_MS = 5_000;

function evidenceError(code, message) {
  return Object.assign(new Error(message), { code });
}

function observeWithin(operation, code, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(
      () => finish(rejectPromise, evidenceError(code, message)),
      EVIDENCE_TIMEOUT_MS,
    );
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(resolvePromise, value),
        () => finish(rejectPromise, evidenceError(code, message)),
      );
  });
}

function failEvidence(evidence, code, message) {
  evidence.failureCode ??= code;
  throw evidenceError(code, message);
}

async function observedUrl(tab, evidence) {
  if (typeof tab?.url !== "function") {
    failEvidence(
      evidence,
      "release_gate_action_evidence_failed",
      "Pointer qualification could not observe its Browser URL",
    );
  }
  const value = await observeWithin(
    () => tab.url(),
    "release_gate_action_evidence_failed",
    "Pointer qualification could not observe its Browser URL",
  ).catch(() =>
    failEvidence(
      evidence,
      "release_gate_action_evidence_failed",
      "Pointer qualification could not observe its Browser URL",
    ),
  );
  try {
    return new URL(value);
  } catch {
    return failEvidence(
      evidence,
      "release_gate_action_evidence_failed",
      "Pointer qualification could not observe its Browser URL",
    );
  }
}

async function observedVisibility(runtime, evidence) {
  const visibility = await observeWithin(
    () => runtime.browser?.capabilities?.get("visibility"),
    "release_gate_action_evidence_failed",
    "Pointer qualification could not observe Browser visibility",
  ).catch(() =>
    failEvidence(
      evidence,
      "release_gate_action_evidence_failed",
      "Pointer qualification could not observe Browser visibility",
    ),
  );
  if (
    typeof visibility?.get !== "function" ||
    typeof visibility?.set !== "function"
  ) {
    failEvidence(
      evidence,
      "release_gate_action_evidence_failed",
      "Pointer qualification could not observe Browser visibility",
    );
  }
  return visibility;
}

function observedVisibilityState(visibility, evidence, message) {
  return observeWithin(
    () => visibility.get(),
    "release_gate_action_evidence_failed",
    message,
  ).catch(() =>
    failEvidence(
      evidence,
      "release_gate_action_evidence_failed",
      message,
    ),
  );
}

function pointerHiddenEvidenceFlow(flow, runtime) {
  const evidence = {
    failureCode: null,
    hiddenPointerActionObserved: false,
    hiddenTransitionObserved: false,
    sameOriginNavigationObserved: false,
    step: 0,
  };
  const targetOrigin = new URL(flow.targetUrl).origin;
  const [navigate, hide, pointerAfterHide] = flow.actions;
  const actions = [
    {
      ...navigate,
      async perform(context) {
        if (evidence.step !== 0) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification actions ran out of order",
          );
        }
        const before = await observedUrl(context?.tab, evidence);
        let result;
        try {
          result = await navigate.perform(context);
        } catch {
          return failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification navigation action failed",
          );
        }
        const after = await observedUrl(context?.tab, evidence);
        if (
          before.href === after.href ||
          before.origin !== targetOrigin ||
          after.origin !== targetOrigin
        ) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification did not observe same-origin navigation",
          );
        }
        evidence.sameOriginNavigationObserved = true;
        evidence.step = 1;
        return result;
      },
    },
    {
      ...hide,
      async perform(context) {
        if (evidence.step !== 1) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification actions ran out of order",
          );
        }
        const visibility = await observedVisibility(runtime, evidence);
        const before = await observedVisibilityState(
          visibility,
          evidence,
          "Pointer qualification could not observe Browser visibility",
        );
        if (before !== true) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification did not begin while visible",
          );
        }
        let result;
        try {
          result = await hide.perform(context);
        } catch {
          return failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification hide action failed",
          );
        }
        const after = await observedVisibilityState(
          visibility,
          evidence,
          "Pointer qualification could not observe Browser visibility",
        );
        if (after !== false) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification did not observe a hidden Browser",
          );
        }
        evidence.hiddenTransitionObserved = true;
        evidence.step = 2;
        return result;
      },
    },
    {
      ...pointerAfterHide,
      requiresFrameEvidence: true,
      async perform(context) {
        if (
          evidence.step !== 2 ||
          evidence.hiddenTransitionObserved !== true
        ) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification actions ran out of order",
          );
        }
        const visibility = await observedVisibility(runtime, evidence);
        const before = await observedVisibilityState(
          visibility,
          evidence,
          "Pointer qualification could not verify hidden state",
        );
        if (before !== false) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification attempted its final action while visible",
          );
        }
        let result;
        try {
          result = await pointerAfterHide.perform(context);
        } catch {
          return failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification hidden pointer action failed",
          );
        }
        const after = await observedVisibilityState(
          visibility,
          evidence,
          "Pointer qualification could not verify hidden state",
        );
        if (after !== false) {
          failEvidence(
            evidence,
            "release_gate_action_evidence_failed",
            "Pointer qualification did not remain hidden",
          );
        }
        evidence.hiddenPointerActionObserved = true;
        evidence.step = 3;
        return result;
      },
    },
  ];
  return {
    ...flow,
    actions: Object.freeze(actions.map((action) => Object.freeze(action))),
    evidence,
  };
}

function childFrameIdentities(frameTree) {
  const root = frameTree?.frameTree;
  const mainFrameId = root?.frame?.id;
  if (typeof mainFrameId !== "string" || mainFrameId.length === 0) {
    return null;
  }
  const identities = new Set([mainFrameId]);
  const children = [];
  const visit = (node, parentFrameId) => {
    for (const child of node?.childFrames ?? []) {
      const frameId = child?.frame?.id;
      if (
        typeof frameId !== "string" ||
        frameId.length === 0 ||
        child.frame.parentId !== parentFrameId ||
        identities.has(frameId)
      ) {
        return false;
      }
      identities.add(frameId);
      children.push(frameId);
      if (!visit(child, frameId)) return false;
    }
    return true;
  };
  return visit(root, mainFrameId) && children.length > 0
    ? children
    : null;
}

function embeddedFrameEvidenceFlow(flow) {
  const evidence = {
    actionObserved: false,
    childFrameCount: 0,
    failureCode: null,
  };
  const [pointer] = flow.actions;
  return {
    ...flow,
    actions: Object.freeze([
      Object.freeze({
        ...pointer,
        requiresChildFramePointerEvidence: true,
        async perform(context) {
          try {
            const cdp = await observeWithin(
              () => context?.tab?.capabilities?.get("cdp"),
              "embedded_frame_qualification_failed",
              "Embedded-frame qualification could not acquire CDP",
            );
            if (typeof cdp?.send !== "function") {
              failEvidence(
                evidence,
                "embedded_frame_qualification_failed",
                "Embedded-frame qualification could not acquire CDP",
              );
            }
            const frameTree = await observeWithin(
              () => cdp.send("Page.getFrameTree"),
              "embedded_frame_qualification_failed",
              "Embedded-frame qualification could not inspect child frames",
            );
            const childFrames = childFrameIdentities(frameTree);
            if (childFrames === null) {
              failEvidence(
                evidence,
                "embedded_frame_qualification_failed",
                "Embedded-frame qualification did not observe child frames",
              );
            }
            evidence.childFrameCount = childFrames.length;
            const result = await pointer.perform(context);
            evidence.actionObserved = true;
            return result;
          } catch {
            return failEvidence(
              evidence,
              "embedded_frame_qualification_failed",
              "Embedded-frame qualification action failed",
            );
          }
        },
      }),
    ]),
    evidence,
  };
}

export function instrumentReleaseQualificationFlows({
  embeddedFrame,
  pointerHiddenFlow,
  runtime,
}) {
  return Object.freeze({
    embeddedFrame:
      embeddedFrame.status === "exercised"
        ? embeddedFrameEvidenceFlow(embeddedFrame)
        : embeddedFrame,
    pointerHiddenFlow: pointerHiddenEvidenceFlow(
      pointerHiddenFlow,
      runtime,
    ),
  });
}

export function verifyReleaseQualificationEvidence({
  capture,
  evidence,
  key,
}) {
  if (key === "pointerSameOriginHidden") {
    if (
      evidence?.step !== 3 ||
      evidence.sameOriginNavigationObserved !== true ||
      evidence.hiddenTransitionObserved !== true ||
      evidence.hiddenPointerActionObserved !== true
    ) {
      throw evidenceError(
        "release_gate_action_evidence_failed",
        "Pointer qualification did not produce the required action evidence",
      );
    }
    if (
      !Number.isInteger(capture?.framesReceived) ||
      capture.framesReceived < 1
    ) {
      throw evidenceError(
        "release_gate_visibility_failed",
        "Recording did not continue after the Browser became hidden",
      );
    }
    return Object.freeze({
      hiddenFrameContinuationObserved: true,
      hiddenPointerActionObserved: true,
      hiddenTransitionObserved: true,
      pageVisibilityChanges:
        Number.isInteger(capture.visibilityChanges)
          ? capture.visibilityChanges
          : null,
      pageVisibilityState:
        typeof capture.visibilityState === "boolean"
          ? capture.visibilityState
          : null,
      sameOriginNavigationObserved: true,
    });
  }
  if (key === "embeddedFrame") {
    if (
      evidence?.actionObserved !== true ||
      !Number.isInteger(evidence.childFrameCount) ||
      evidence.childFrameCount < 1 ||
      !Number.isInteger(capture?.cursorChildFrameEventsCaptured) ||
      capture.cursorChildFrameEventsCaptured < 1
    ) {
      throw evidenceError(
        "embedded_frame_qualification_failed",
        "Embedded-frame qualification lacked child-frame pointer evidence",
      );
    }
    return Object.freeze({
      childFrameObserved: true,
      childFramePointerEventsCaptured:
        capture.cursorChildFrameEventsCaptured,
      childFramesObserved: evidence.childFrameCount,
    });
  }
  return null;
}
