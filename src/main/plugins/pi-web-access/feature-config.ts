import { createConfigFileReader } from "./config-file.ts";

type FeatureConfig = { image?: { enabled?: unknown } };

const loadFeatureConfig = createConfigFileReader<FeatureConfig>();

export function isImageEnabled(): boolean {
	return loadFeatureConfig().image?.enabled !== false;
}

export function canAttachImages(): boolean {
	try {
		return isImageEnabled();
	} catch {
		return false;
	}
}
