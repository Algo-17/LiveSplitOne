import React, { useState, useEffect, useRef, useCallback } from "react";
import {
    getSplitsInfos,
    getSplitsOrder,
    storeSplitsOrder,
    SplitsInfo,
    deleteSplits as storageDeleteSplits,
    copySplits as storageCopySplits,
    loadSplits,
    storeRunWithoutDisposing,
    storeSplitsKey,
} from "../../storage";
import { Language, Run, Segment, TimerPhase } from "../../livesplit-core";
import { toast } from "react-toastify";
import {
    openFileAsArrayBuffer,
    exportFile,
    convertFileToArrayBuffer,
    FILE_EXT_SPLITS,
} from "../../util/FileUtil";
import { Option, bug, maybeDisposeAndThen } from "../../util/OptionUtil";
import { DragUpload } from "../components/DragUpload";
import { GeneralSettings } from "./MainSettings";
import { LSOCommandSink } from "../../util/LSOCommandSink";
import { showDialog } from "../components/Dialog";
import { Label, resolve } from "../../localization";
import {
    ArrowLeft,
    Circle,
    Copy,
    Download,
    FolderOpen,
    GripVertical,
    Plus,
    Save,
    SquarePen,
    Trash,
    Upload,
} from "lucide-react";

import classes from "../../css/SplitsSelection.module.css";
import sidebarClasses from "../../css/Sidebar.module.css";

function applyOrder(
    splitsInfos: Array<[number, SplitsInfo]>,
    order: number[] | undefined,
): Array<[number, SplitsInfo]> {
    if (!order || order.length === 0) return splitsInfos;

    const infoMap = new Map(splitsInfos.map(([k, v]) => [k, v]));
    const orderedSet = new Set(order);

    const ordered = order
        .filter((k) => infoMap.has(k))
        .map((k) => [k, infoMap.get(k)!] as [number, SplitsInfo]);

    const appended = splitsInfos.filter(([k]) => !orderedSet.has(k));

    return [...ordered, ...appended];
}

export interface EditingInfo {
    splitsKey?: number;
    run: Run;
}

export interface Props {
    commandSink: LSOCommandSink;
    openedSplitsKey?: number;
    callbacks: Callbacks;
    generalSettings: GeneralSettings;
    splitsModified: boolean;
}

interface Callbacks {
    openRunEditor(editingInfo: EditingInfo): void;
    setSplitsKey(newKey?: number): void;
    openTimerView(): void;
    renderViewWithSidebar(
        renderedView: React.JSX.Element,
        sidebarContent: React.JSX.Element,
    ): React.JSX.Element;
    saveSplits(): Promise<void>;
}

export function SplitsSelection(props: Props) {
    const lang = props.generalSettings.lang;
    const [splitsInfos, setSplitsInfos] = useState<
        Array<[number, SplitsInfo]> | undefined
    >();
    const [splitsOrder, setSplitsOrder] = useState<number[] | undefined>();

    useEffect(() => {
        async function fetchData() {
            const [infos, order] = await Promise.all([
                getSplitsInfos(),
                getSplitsOrder(),
            ]);
            setSplitsInfos(infos);
            setSplitsOrder(order);
        }
        fetchData();
    }, []);

    const refreshDb = async () => {
        const infos = await getSplitsInfos();
        setSplitsInfos(infos);
        setSplitsOrder((prev) => {
            if (!prev) return prev;
            const validKeys = new Set(infos.map(([k]) => k));
            const cleaned = prev.filter((k) => validKeys.has(k));
            if (cleaned.length !== prev.length) {
                storeSplitsOrder(cleaned);
            }
            return cleaned;
        });
    };

    const orderedSplitsInfos =
        splitsInfos !== undefined
            ? applyOrder(splitsInfos, splitsOrder)
            : undefined;

    const reorderSplits = (fromKey: number, toKey: number | undefined) => {
        const current = orderedSplitsInfos?.map(([k]) => k) ?? [];
        const newOrder = current.filter((k) => k !== fromKey);
        if (toKey === undefined) {
            newOrder.push(fromKey);
        } else {
            const toIdx = newOrder.indexOf(toKey);
            if (toIdx === -1) return;
            newOrder.splice(toIdx, 0, fromKey);
        }
        setSplitsOrder(newOrder);
        storeSplitsOrder(newOrder);
    };

    const saveSplits = async () => {
        await props.callbacks.saveSplits();
        refreshDb();
    };

    const exportTimerSplits = () => {
        props.commandSink.markAsUnmodified();
        const name = props.commandSink.extendedFileName(true);
        const lss = props.commandSink.saveAsLssBytes();
        try {
            exportFile(name + ".lss", lss);
        } catch (_) {
            toast.error(resolve(Label.FailedToExportSplits, lang));
        }
    };

    const openTimerView = () => {
        props.callbacks.openTimerView();
    };

    return props.callbacks.renderViewWithSidebar(
        <View
            {...props}
            splitsInfos={orderedSplitsInfos}
            refreshDb={refreshDb}
            reorderSplits={reorderSplits}
            lang={lang}
        />,
        <SideBar
            commandSink={props.commandSink}
            callbacks={props.callbacks}
            splitsModified={props.splitsModified}
            saveSplits={saveSplits}
            exportTimerSplits={exportTimerSplits}
            openTimerView={openTimerView}
            lang={lang}
        />,
    );
}

function View({
    commandSink,
    openedSplitsKey,
    callbacks,
    splitsInfos,
    refreshDb,
    reorderSplits,
    lang,
}: {
    commandSink: LSOCommandSink;
    openedSplitsKey?: number;
    callbacks: Callbacks;
    splitsInfos?: Array<[number, SplitsInfo]>;
    refreshDb: () => Promise<void>;
    reorderSplits: (fromKey: number, toKey: number | undefined) => void;
    lang: Language | undefined;
}) {
    const [dragKey, setDragKey] = useState<number | null>(null);
    const dragKeyRef = useRef<number | null>(null);
    const tableRef = useRef<HTMLDivElement>(null);
    const dragOverRowRef = useRef<HTMLElement | null>(null);
    const dropAfterRef = useRef(false);
    const reorderSplitsRef = useRef(reorderSplits);
    useEffect(() => {
        reorderSplitsRef.current = reorderSplits;
    });

    const clearDragOver = useCallback(() => {
        if (dragOverRowRef.current) {
            dragOverRowRef.current
                .querySelector("[data-drop-indicator]")
                ?.remove();
            dragOverRowRef.current = null;
        }
        dropAfterRef.current = false;
    }, []);

    useEffect(() => {
        const table = tableRef.current;
        if (!table) return;

        const handleDragOver = (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            const row = (e.target as Element).closest<HTMLElement>(
                "[data-splits-key]",
            );
            if (!row) return;

            const rect = row.getBoundingClientRect();
            const dropAfter = e.clientY > rect.top + rect.height / 2;

            if (row === dragOverRowRef.current && dropAfter === dropAfterRef.current) return;
            clearDragOver();
            dragOverRowRef.current = row;
            dropAfterRef.current = dropAfter;
            const indicator = document.createElement("div");
            indicator.classList.add(classes.dropIndicator);
            if (dropAfter) indicator.classList.add(classes.dropIndicatorEnd);
            indicator.dataset.dropIndicator = "";
            if (dropAfter) {
                row.append(indicator);
            } else {
                row.prepend(indicator);
            }
        };

        const handleDragLeave = (e: DragEvent) => {
            if (!table.contains(e.relatedTarget as Node)) {
                clearDragOver();
            }
        };

        const handleDrop = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const targetRow = dragOverRowRef.current;
            if (dragKeyRef.current !== null && targetRow) {
                if (dropAfterRef.current) {
                    const nextRow = targetRow.nextElementSibling as HTMLElement | null;
                    const toKey = nextRow ? Number(nextRow.dataset.splitsKey) : undefined;
                    reorderSplitsRef.current(dragKeyRef.current, toKey);
                } else {
                    const toKey = Number(targetRow.dataset.splitsKey);
                    if (dragKeyRef.current !== toKey) {
                        reorderSplitsRef.current(dragKeyRef.current, toKey);
                    }
                }
            }
            dragKeyRef.current = null;
            setDragKey(null);
            clearDragOver();
        };

        table.addEventListener("dragover", handleDragOver);
        table.addEventListener("dragleave", handleDragLeave);
        table.addEventListener("drop", handleDrop);

        return () => {
            table.removeEventListener("dragover", handleDragOver);
            table.removeEventListener("dragleave", handleDragLeave);
            table.removeEventListener("drop", handleDrop);
        };
        // splitsInfos is the dep that causes the table to appear in the DOM;
        // including it ensures listeners are attached once the ref is populated.
    }, [clearDragOver, splitsInfos]);

    const storeRun = async (run: Run) => {
        try {
            if (run.len() === 0) {
                toast.error(resolve(Label.CantImportEmptySplits, lang));
                return;
            }
            await storeRunWithoutDisposing(run, undefined, lang);
            await refreshDb();
        } finally {
            run[Symbol.dispose]();
        }
    };

    const addNewSplits = async () => {
        const run = Run.new();
        run.pushSegment(Segment.new(resolve(Label.NewSegmentName, lang)));
        await storeRun(run);
    };

    const importSplitsFromArrayBuffer = async (
        buffer: [ArrayBuffer, File],
    ): Promise<Option<Error>> => {
        const [file] = buffer;
        using result = Run.parseArray(new Uint8Array(file), "");
        if (result.parsedSuccessfully()) {
            await storeRun(result.unwrap());
        } else {
            return Error(resolve(Label.CouldNotParseSplits, lang));
        }
        return;
    };

    const importSplits = async () => {
        const splits = await openFileAsArrayBuffer(FILE_EXT_SPLITS);
        if (splits === undefined) {
            return;
        }
        if (splits instanceof Error) {
            toast.error(
                `${resolve(Label.FailedToReadFile, lang)} ${splits.message}`,
            );
            return;
        }

        const result = await importSplitsFromArrayBuffer(splits);
        if (result != null) {
            toast.error(
                `${resolve(Label.FailedToImportSplits, lang)} ${result.message}`,
            );
        }
    };

    const importSplitsFromFile = async (file: File) => {
        const splits = await convertFileToArrayBuffer(file);
        if (splits instanceof Error) {
            toast.error(
                `${resolve(Label.FailedToReadFile, lang)} ${splits.message}`,
            );
            return;
        }

        const result = await importSplitsFromArrayBuffer(splits);
        if (result != null) {
            toast.error(
                `${resolve(Label.FailedToImportSplits, lang)} ${result.message}`,
            );
        }
    };

    const getRunFromKey = async (key: number): Promise<Run | undefined> => {
        const splitsData = await loadSplits(key);
        if (splitsData === undefined) {
            bug("The splits key is invalid.", lang);
            return;
        }

        using result = Run.parseArray(new Uint8Array(splitsData), "");

        if (result.parsedSuccessfully()) {
            return result.unwrap();
        } else {
            bug("Couldn't parse the splits.", lang);
            return;
        }
    };

    const openSplits = async (key: number) => {
        const isModified = commandSink.hasBeenModified();
        if (isModified) {
            const [result] = await showDialog({
                title: resolve(Label.DiscardChangesTitle, lang),
                description: resolve(Label.DiscardChangesDescription, lang),
                buttons: [resolve(Label.Yes, lang), resolve(Label.No, lang)],
            });
            if (result === 1) {
                return;
            }
        }

        using run = await getRunFromKey(key);
        if (run === undefined) {
            return;
        }
        maybeDisposeAndThen(commandSink.setRun(run), () =>
            toast.error(resolve(Label.LoadedSplitsInvalid, lang)),
        );
        callbacks.setSplitsKey(key);
    };

    const editSplits = async (key: number) => {
        const run = await getRunFromKey(key);
        if (run !== undefined) {
            callbacks.openRunEditor({ splitsKey: key, run });
        }
    };

    const exportSplits = async (key: number, info: SplitsInfo) => {
        try {
            const splitsData = await loadSplits(key);
            if (splitsData === undefined) {
                throw Error("The splits key is invalid.");
            }

            exportFile(`${info.game} - ${info.category}.lss`, splitsData);
        } catch (_) {
            toast.error(resolve(Label.FailedToExportSplits, lang));
        }
    };

    const copySplits = async (key: number) => {
        await storageCopySplits(key);
        await refreshDb();
    };

    const deleteSplits = async (key: number) => {
        const [result] = await showDialog({
            title: resolve(Label.DeleteSplitsTitle, lang),
            description: resolve(Label.DeleteSplitsDescription, lang),
            buttons: [resolve(Label.Yes, lang), resolve(Label.No, lang)],
        });
        if (result !== 0) {
            return;
        }

        await storageDeleteSplits(key);
        if (key === openedSplitsKey) {
            callbacks.setSplitsKey(undefined);
            storeSplitsKey(undefined);
        }
        await refreshDb();
    };

    let content;

    if (splitsInfos == null) {
        content = (
            <div className={classes.loading}>
                <div className={classes.loadingText}>
                    {resolve(Label.Loading, lang)}
                </div>
            </div>
        );
    } else {
        content = (
            <div className={classes.splitsSelectionContainer}>
                <div className={classes.mainActions}>
                    <button onClick={addNewSplits}>
                        <Plus strokeWidth={2.5} />
                        {resolve(Label.Add, lang)}
                    </button>
                    <button onClick={importSplits}>
                        <Download strokeWidth={2.5} />
                        {resolve(Label.Import, lang)}
                    </button>
                </div>
                {splitsInfos?.length > 0 && (
                    <div
                        className={classes.splitsTable}
                        ref={tableRef}
                    >
                        {splitsInfos.map(([key, info]) => (
                            <SavedSplitsRow
                                key={key}
                                openedSplitsKey={openedSplitsKey}
                                splitsKey={key}
                                info={info}
                                openSplits={openSplits}
                                editSplits={editSplits}
                                exportSplits={exportSplits}
                                copySplits={copySplits}
                                deleteSplits={deleteSplits}
                                isDragging={dragKey === key}
                                onDragStart={() => {
                                    dragKeyRef.current = key;
                                    setDragKey(key);
                                }}
                                onDragEnd={() => {
                                    dragKeyRef.current = null;
                                    setDragKey(null);
                                    clearDragOver();
                                }}
                                lang={lang}
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    }
    return (
        <DragUpload importSplits={importSplitsFromFile}>{content}</DragUpload>
    );
}

function SavedSplitsRow({
    openedSplitsKey,
    splitsKey,
    info,
    openSplits,
    editSplits,
    exportSplits,
    copySplits,
    deleteSplits,
    isDragging,
    onDragStart,
    onDragEnd,
    lang,
}: {
    openedSplitsKey?: number;
    splitsKey: number;
    info: SplitsInfo;
    openSplits: (key: number) => void;
    editSplits: (key: number) => void;
    exportSplits: (key: number, info: SplitsInfo) => void;
    copySplits: (key: number) => void;
    deleteSplits: (key: number) => void;
    isDragging: boolean;
    onDragStart: () => void;
    onDragEnd: () => void;
    lang: Language | undefined;
}) {
    const isOpened = splitsKey === openedSplitsKey;
    const classNames = [classes.splitsRow];
    if (isOpened) {
        classNames.push(classes.selected);
    }
    if (isDragging) {
        classNames.push(classes.dragging);
    }

    return (
        <div
            className={classNames.join(" ")}
            data-splits-key={splitsKey}
        >
            <div
                className={classes.dragHandle}
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", "");
                    const row = e.currentTarget.parentElement;
                    if (row) {
                        const rect = row.getBoundingClientRect();
                        // Inline the computed background so the ghost is opaque —
                        // CSS variables don't resolve in browser drag-image snapshots.
                        row.style.backgroundColor =
                            window.getComputedStyle(row).backgroundColor;
                        e.dataTransfer.setDragImage(
                            row,
                            e.clientX - rect.left,
                            e.clientY - rect.top,
                        );
                        requestAnimationFrame(() => {
                            row.style.backgroundColor = "";
                        });
                    }
                    onDragStart();
                }}
                onDragEnd={onDragEnd}
            >
                <GripVertical size={16} />
            </div>
            <SplitsTitle
                game={info.game}
                category={info.category}
                lang={lang}
            />
            <div className={classes.splitsRowButtons}>
                {isOpened ? null : (
                    <>
                        <button
                            aria-label={resolve(Label.OpenSplits, lang)}
                            onClick={() => openSplits(splitsKey)}
                        >
                            <FolderOpen strokeWidth={2.5} />
                        </button>
                        <button
                            aria-label={resolve(Label.EditSplits, lang)}
                            onClick={() => editSplits(splitsKey)}
                        >
                            <SquarePen strokeWidth={2.5} />
                        </button>
                        <button
                            aria-label={resolve(Label.ExportSplits, lang)}
                            onClick={() => exportSplits(splitsKey, info)}
                        >
                            <Upload strokeWidth={2.5} />
                        </button>
                    </>
                )}
                <button
                    aria-label={resolve(Label.CopySplits, lang)}
                    onClick={() => copySplits(splitsKey)}
                >
                    <Copy strokeWidth={2.5} />
                </button>
                <button
                    aria-label={resolve(Label.RemoveSplits, lang)}
                    onClick={() => deleteSplits(splitsKey)}
                >
                    <Trash strokeWidth={2.5} />
                </button>
            </div>
        </div>
    );
}

function SplitsTitle({
    game,
    category,
    lang,
}: {
    game: string;
    category: string;
    lang: Language | undefined;
}) {
    return (
        <div className={classes.splitsTitleText}>
            <div className={`${classes.splitsText} ${classes.splitsGame}`}>
                {game || resolve(Label.Untitled, lang)}
            </div>
            <div className={classes.splitsText}>
                {category || resolve(Label.NoCategory, lang)}
            </div>
        </div>
    );
}

function SideBar({
    commandSink,
    callbacks,
    splitsModified,
    saveSplits,
    exportTimerSplits,
    openTimerView,
    lang,
}: {
    commandSink: LSOCommandSink;
    callbacks: any;
    splitsModified: boolean;
    saveSplits: () => void;
    exportTimerSplits: () => void;
    openTimerView: () => void;
    lang: Language | undefined;
}) {
    return (
        <>
            <h1>{resolve(Label.Splits, lang)}</h1>
            <hr />
            <button
                onClick={(_) => {
                    if (commandSink.currentPhase() !== TimerPhase.NotRunning) {
                        toast.error(resolve(Label.EditWhileRunningError, lang));
                        return;
                    }
                    const run = commandSink.getRun().clone();
                    callbacks.openRunEditor({ run });
                }}
            >
                <SquarePen strokeWidth={2.5} />
                {resolve(Label.Edit, lang)}
            </button>
            <button onClick={saveSplits}>
                <Save strokeWidth={2.5} />
                <span>
                    {resolve(Label.Save, lang)}
                    {splitsModified && (
                        <Circle
                            strokeWidth={0}
                            size={12}
                            fill="currentColor"
                            className={sidebarClasses.modifiedIcon}
                        />
                    )}
                </span>
            </button>
            <button onClick={exportTimerSplits}>
                <Upload strokeWidth={2.5} />
                {resolve(Label.Export, lang)}
            </button>
            <hr />
            <button onClick={openTimerView}>
                <ArrowLeft strokeWidth={2.5} />
                {resolve(Label.Back, lang)}
            </button>
        </>
    );
}
