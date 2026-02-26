import { useState, useMemo, Suspense } from 'react';
import { useLicenses, mergeLicenses, License } from './hooks/useLicenses';
import { openUrl } from '@tauri-apps/plugin-opener';
import "./App.css";

{
    const root = document.getElementById('root');
    if (root) {
        root.style.borderRadius = '0';
    }
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
                <h1 className="text-xl font-bold mb-4">Open Source Licenses</h1>

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
