import { useState, useMemo, Suspense, useEffect } from 'react';
import { useLicenses, mergeLicenses, License } from './hooks/useLicenses';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import "./App.css";

// remove border radius from root element
{
    const root = document.getElementById('root');
    if (root) {
        root.style.borderRadius = '0';
    }
}

const REPO_URL = 'https://github.com/kot149/zmk-battery-center';

function AboutSection() {
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        getVersion().then(setVersion);
    }, []);

    return (
        <div className="mb-2 pb-2 border-b border-border">
            <h1 className="text-3xl font-bold mb-2 flex items-baseline justify-center gap-2">
                zmk-battery-center
                {version && (
                    <span className="text-lg text-muted-foreground font-normal">v{version}</span>
                )}
            </h1>
            <div className="flex flex-col items-center justify-center gap-1">
                <p className="text-muted-foreground justify-center text-center">
                    A system tray app to monitor the battery level of ZMK-based keyboards.
                </p>
                <p>
                    <a
                        href={REPO_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                        onClick={(e) => {
                            e.preventDefault();
                            openUrl(REPO_URL);
                        }}
                        >
                        GitHub Repo
                    </a>
                    <span className="text-muted-foreground mx-2">|</span>
                    <a
                        href="https://github.com/kot149/zmk-battery-center/blob/main/LICENSE.md"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                        >
                        License
                    </a>
                    <span className="text-muted-foreground mx-2">|</span>
                    <a
                        href="https://github.com/kot149/zmk-battery-center/issues"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                        >
                        Report an Issue
                    </a>
                </p>
            </div>
        </div>
    );
}

function LicenseItem({ license }: { license: License }) {
    const [isExpanded, setIsExpanded] = useState(false);

    const handleOpenUrl = (url: string) => {
        openUrl(url);
    };

    return (
        <div className="bg-card rounded-lg border border-border">
            <div
                className={`p-3 ${license.licenseText ? 'cursor-pointer hover:bg-secondary/50' : ''}`}
                onClick={() => license.licenseText && setIsExpanded(prev => !prev)}
            >
                <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                        <div className="font-medium truncate flex items-center gap-2">
                            <span className="inline-flex w-4 shrink-0 items-center justify-center text-xs">
                                {license.licenseText && (
                                    <span className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                                        &#9654;
                                    </span>
                                )}
                            </span>
                            {license.name}
                            { license.version && (
                                <span className="text-muted-foreground font-normal">
                                    v{license.version}
                                </span>
                            )}
                        </div>
                        {license.author && (
                            <div className="text-sm text-muted-foreground truncate ml-6">
                                by {license.author}
                            </div>
                        )}
                    </div>
                    <div className="shrink-0">
                        <span className="inline-block px-2 py-1 text-xs bg-secondary text-secondary-foreground rounded">
                            {license.license ?? 'Unknown'}
                        </span>
                    </div>
                </div>
                {license.repository && (
                    <a
                        href={license.repository}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline truncate block mt-1 ml-6"
                        onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            handleOpenUrl(license.repository!);
                        }}
                    >
                        {license.repository}
                    </a>
                )}
            </div>
            {isExpanded && license.licenseText && (
                <div className="border-t border-border p-3">
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono bg-background p-3 rounded max-h-64 overflow-y-auto">
                        {license.licenseText}
                    </pre>
                </div>
            )}
        </div>
    );
}


function LicensesList() {
    const licensesData = useLicenses();
    const [searchQuery, setSearchQuery] = useState('');

    const allLicenses = useMemo(() => mergeLicenses(licensesData), [licensesData]);

    const filteredLicenses = useMemo(() => {
        if (!searchQuery) return allLicenses;
        const query = searchQuery.toLowerCase();
        return allLicenses.filter(license =>
            license.name.toLowerCase().includes(query) ||
            (license.license?.toLowerCase().includes(query) ?? false)
        );
    }, [allLicenses, searchQuery]);

    return (
        <div className="dark h-screen bg-background text-foreground flex flex-col overflow-hidden">
            {/* Header */}
            <div className="shrink-0 p-4 border-b border-border">
                <AboutSection />
                <hr className="my-3 border-ring w-full" />
                <h2 className="text-2xl font-bold mb-2">Open Source Licenses</h2>

                <p className="text-foreground mb-4 ml-1">
                    This app consists of the following open source software. Huge thanks to everyone who contributed to them and made this app possible!
                </p>

                {/* Search */}
                <input
                    type="text"
                    placeholder="Search packages or licenses..."
                    className="w-full px-3 py-2 bg-card border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
            </div>

            {/* License list */}
            <div className="flex-1 overflow-y-auto p-4">
                <div className="space-y-2">
                    {filteredLicenses.map((license) => (
                        <LicenseItem
                            key={`${license.name}@${license.version}`}
                            license={license}
                        />
                    ))}
                </div>
                {filteredLicenses.length === 0 && (
                    <div className="text-center text-muted-foreground py-8">
                        No packages found
                    </div>
                )}
            </div>
        </div>
    );
}

const loadingFallback = (
    <div className="dark h-screen bg-background text-foreground p-4 flex items-center justify-center">
        <div className="text-muted-foreground">Loading licenses...</div>
    </div>
);

function LicensesApp() {
    return (
        <Suspense fallback={loadingFallback}>
            <LicensesList />
        </Suspense>
    );
}

export default LicensesApp;
