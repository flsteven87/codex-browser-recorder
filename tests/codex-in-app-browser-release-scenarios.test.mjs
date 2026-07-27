import assert from "node:assert/strict";
import test from "node:test";

import {
  getReleaseQualificationScenario,
  getReleaseQualificationScenarios,
} from "../scripts/codex-in-app-browser-release-scenarios.mjs";

test("exposes the complete immutable release qualification scenario contract", () => {
  const scenarios = getReleaseQualificationScenarios();

  assert.deepEqual(
    scenarios.map(
      ({
        actionModalities,
        availability,
        evidenceKind,
        executionKind,
        flowProperty,
        flowValidationOrder,
        key,
        publicErrorScenario,
        recordingMode,
        recordingName,
        resultKind,
        runtimeUnsupportedResult,
        targetFlowProperty,
      }) => ({
        actionModalities,
        availability,
        evidenceKind,
        executionKind,
        flowProperty,
        flowValidationOrder,
        key,
        publicErrorScenario,
        recordingMode,
        recordingName,
        resultKind,
        runtimeUnsupportedResult,
        targetFlowProperty,
      }),
    ),
    [
      {
        actionModalities: ["pointer", "programmatic", "pointer"],
        availability: "required",
        evidenceKind: "pointer_hidden",
        executionKind: "recording_success",
        flowProperty: "pointerHiddenFlow",
        flowValidationOrder: 2,
        key: "pointerSameOriginHidden",
        publicErrorScenario: true,
        recordingMode: undefined,
        recordingName: "qualification-pointer-hidden",
        resultKind: "pointer_visual",
        runtimeUnsupportedResult: null,
        targetFlowProperty: "pointerHiddenFlow",
      },
      {
        actionModalities: null,
        availability: "required",
        evidenceKind: "unattended",
        executionKind: "recording_success",
        flowProperty: "sequentialFlow",
        flowValidationOrder: 3,
        key: "sequential",
        publicErrorScenario: true,
        recordingMode: "unattended",
        recordingName: "qualification-sequential",
        resultKind: "sequential_isolation",
        runtimeUnsupportedResult: null,
        targetFlowProperty: "sequentialFlow",
      },
      {
        actionModalities: null,
        availability: "required",
        evidenceKind: null,
        executionKind: "expected_failure",
        flowProperty: "crossOriginFlow",
        flowValidationOrder: 0,
        key: "crossOrigin",
        publicErrorScenario: false,
        recordingMode: undefined,
        recordingName: "qualification-cross-origin",
        resultKind: "expected_failure",
        runtimeUnsupportedResult: null,
        targetFlowProperty: "crossOriginFlow",
      },
      {
        actionModalities: null,
        availability: "required",
        evidenceKind: null,
        executionKind: "cancellation",
        flowProperty: null,
        flowValidationOrder: null,
        key: "cancellation",
        publicErrorScenario: false,
        recordingMode: undefined,
        recordingName: "qualification-cancellation",
        resultKind: "cancellation",
        runtimeUnsupportedResult: null,
        targetFlowProperty: "pointerHiddenFlow",
      },
      {
        actionModalities: ["pointer"],
        availability: "when_exercised",
        evidenceKind: "embedded_frame",
        executionKind: "recording_success",
        flowProperty: "embeddedFrame",
        flowValidationOrder: 1,
        key: "embeddedFrame",
        publicErrorScenario: true,
        recordingMode: undefined,
        recordingName: "qualification-embedded-frame",
        resultKind: "embedded_frame",
        runtimeUnsupportedResult: {
          limitation: "runtime_does_not_expose_embedded_frame_control",
          status: "runtime_unsupported",
        },
        targetFlowProperty: "embeddedFrame",
      },
    ],
  );
  assert.equal(Object.isFrozen(scenarios), true);
  assert.equal(scenarios.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(scenarios[0].actionModalities), true);
  assert.equal(Object.isFrozen(scenarios[4].runtimeUnsupportedResult), true);
  assert.equal(new Set(scenarios.map(({ key }) => key)).size, scenarios.length);
  assert.equal(
    getReleaseQualificationScenario("pointerSameOriginHidden"),
    scenarios[0],
  );
  assert.equal(getReleaseQualificationScenario("unknown"), null);
  assert.throws(() => scenarios.push({}), TypeError);
  assert.throws(() => {
    scenarios[0].key = "changed";
  }, TypeError);
});
