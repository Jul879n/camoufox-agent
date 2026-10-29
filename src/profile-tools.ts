import { buildSuccessContent, buildToolError } from "./responses.js";
import { deleteProfile, listProfiles } from "./profiles.js";
import { describeError } from "./utils.js";

export async function handleProfilesList() {
  return buildSuccessContent({ profiles: listProfiles() });
}

export async function handleProfileDelete(input: { name: string }) {
  try {
    return buildSuccessContent({ name: input.name, deleted: deleteProfile(input.name) });
  } catch (error) {
    return buildToolError(`Failed to delete profile. Error: ${describeError(error)}`);
  }
}
