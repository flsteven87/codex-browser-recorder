const RELEASE_QUALIFICATION_SCENARIOS = Object.freeze([
  Object.freeze({
    actionModalities: Object.freeze([
      "pointer",
      "programmatic",
      "pointer",
    ]),
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
  }),
  Object.freeze({
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
  }),
  Object.freeze({
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
  }),
  Object.freeze({
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
  }),
  Object.freeze({
    actionModalities: Object.freeze(["pointer"]),
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
    runtimeUnsupportedResult: Object.freeze({
      limitation: "runtime_does_not_expose_embedded_frame_control",
      status: "runtime_unsupported",
    }),
    targetFlowProperty: "embeddedFrame",
  }),
]);

const SCENARIOS_BY_KEY = new Map(
  RELEASE_QUALIFICATION_SCENARIOS.map((scenario) => [scenario.key, scenario]),
);

export function getReleaseQualificationScenario(key) {
  return SCENARIOS_BY_KEY.get(key) ?? null;
}

export function getReleaseQualificationScenarios() {
  return RELEASE_QUALIFICATION_SCENARIOS;
}
