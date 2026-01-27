import { use } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface JsLicense {
    name: string;
    version: string;
    license: string | null;
    repository: string | null;
    publisher: string | null;
}

interface CargoLicense {
    name: string;
    version: string;
    license: string | null;
    authors: string[] | null;
    repository: string | null;
}

export interface LicensesData {
    js_licenses: JsLicense[];
    cargo_licenses: CargoLicense[];
}

export interface License {
    name: string;
    version: string;
    license: string | null;
    repository: string | null;
    author: string | null;
}

// Create the promise once, outside of the component
let licensesPromise: Promise<LicensesData> | null = null;

function fetchLicenses(): Promise<LicensesData> {
    if (!licensesPromise) {
        licensesPromise = invoke<LicensesData>('get_licenses');
    }
    return licensesPromise;
}

export function useLicenses(): LicensesData {
    return use(fetchLicenses());
}

export function mergeLicenses(licensesData: LicensesData): License[] {
    const licenseMap = new Map<string, License>();

    // Add JS licenses
    for (const license of licensesData.js_licenses) {
        const key = `${license.name}@${license.version}`;
        if (!licenseMap.has(key)) {
            licenseMap.set(key, {
                name: license.name,
                version: license.version,
                license: license.license,
                repository: license.repository,
                author: license.publisher ?? null,
            });
        }
    }

    // Add Cargo licenses
    for (const license of licensesData.cargo_licenses) {
        const key = `${license.name}@${license.version}`;
        if (!licenseMap.has(key)) {
            licenseMap.set(key, {
                name: license.name,
                version: license.version,
                license: license.license,
                repository: license.repository,
                author: license.authors?.join(', ') ?? null,
            });
        }
    }

    // Sort by name
    return Array.from(licenseMap.values()).sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
}
