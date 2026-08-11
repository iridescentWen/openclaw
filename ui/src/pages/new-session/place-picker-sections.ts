import type { DraftCloudProfile, DraftEnvironment, DraftNode } from "./discovery.ts";

export function resolvePlacePickerSections(params: {
  environments: readonly DraftEnvironment[] | null;
  execNodes: readonly DraftNode[];
  cloudProfiles: readonly DraftCloudProfile[];
}): { deviceNodes: DraftNode[]; cloudProfiles: DraftCloudProfile[] } {
  const environmentById = params.environments
    ? new Map(params.environments.map((environment) => [environment.id, environment]))
    : null;
  return {
    deviceNodes: params.execNodes.filter((node) => {
      if (!node.connected || !node.canExec) {
        return false;
      }
      if (environmentById === null) {
        // No catalog snapshot: intersect the legacy fallback with current node presence only.
        return true;
      }
      const environment = environmentById.get(`node:${node.nodeId}`);
      return environment?.type === "node";
    }),
    cloudProfiles: [...params.cloudProfiles],
  };
}
