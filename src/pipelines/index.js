/**
 * Pipeline registry.
 *
 * Each pipeline exports:
 *   - planTasks({ project, goal, clarifications })   → returns plan JSON
 *   - executeTask({ project, task, existingFiles })  → returns result JSON
 *
 * The orchestrator dispatches by project.kind.
 */

import * as webApp from "./webApp.js";
import * as staticSite from "./staticSite.js";
import * as backendApi from "./backendApi.js";
import * as mobileApp from "./mobileApp.js";
import * as script from "./script.js";
import * as docPipe from "./document.js";
import * as designKit from "./designKit.js";
import * as video from "./video.js";
import * as research from "./research.js";
import * as automation from "./automation.js";
import * as freeform from "./freeform.js";

const REGISTRY = {
  web_app: webApp,
  static_site: staticSite,
  backend_api: backendApi,
  mobile_app: mobileApp,
  script: script,
  document: docPipe,
  design_kit: designKit,
  video: video,
  research: research,
  automation: automation,
  freeform: freeform
};

export function getPipeline(kind) {
  return REGISTRY[kind] || REGISTRY.freeform;
}

export function listKinds() {
  return Object.keys(REGISTRY);
}
