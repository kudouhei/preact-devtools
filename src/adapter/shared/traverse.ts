import { ID } from "../../view/store/types";
import { FilterState } from "../adapter/filter";
import { Commit, MsgTypes } from "../protocol/events";
import { getStringId } from "../protocol/string-table";
import {
	createVNodeId,
	getVNodeById,
	getVNodeId,
	hasVNodeId,
	IdMappingState,
	updateVNodeId,
} from "./idMapper";
import { ProfilerState } from "../adapter/profiler";
import { getDevtoolsType, RendererConfig } from "./renderer";
import { getRenderReason, RenderReason } from "./renderReasons";
import { createStats, DiffType, updateDiffStats } from "./stats";
import { NodeType } from "../../constants";
import { getDiffType, recordComponentStats } from "./stats";
import { measureUpdate } from "../adapter/highlightUpdates";
import { PreactBindings, SharedVNode } from "./bindings";

function getHocName(name: string) {
	const idx = name.indexOf("(");
	if (idx === -1) return null;

	const wrapper = name.slice(0, idx);
	return wrapper ? wrapper : null;
}

function addHocs(commit: Commit, id: ID, hocs: string[]) {
	if (hocs.length > 0) {
		commit.operations.push(MsgTypes.HOC_NODES, id, hocs.length);
		for (let i = 0; i < hocs.length; i++) {
			const stringId = getStringId(commit.strings, hocs[i]);
			commit.operations.push(stringId);
		}
	}
}

function isTextNode(dom: HTMLElement | Text | null): dom is Text {
	return dom != null && dom.nodeType === NodeType.Text;
}

function updateHighlight<T extends SharedVNode>(
	profiler: ProfilerState,
	vnode: T,
	helpers: PreactBindings<T>,
) {
	if (profiler.highlightUpdates && helpers.isComponent(vnode)) {
		let dom = helpers.getDom(vnode);
		if (isTextNode(dom)) {
			dom = dom.parentNode as HTMLElement;
		}
		if (dom && !profiler.pendingHighlightUpdates.has(dom)) {
			profiler.pendingHighlightUpdates.add(dom);
			measureUpdate(profiler.updateRects, dom);
		}
	}
}

function getFilteredChildren<T extends SharedVNode>(
	vnode: T,
	filters: FilterState,
	config: RendererConfig,
	helpers: PreactBindings<T>,
): T[] {
	const children = helpers.getActualChildren(vnode);
	const stack = children.slice();

	const out: T[] = [];

	let child;
	while (stack.length) {
		child = stack.pop();
		if (child != null) {
			if (!shouldFilter(child, filters, config, helpers)) {
				out.push(child);
			} else {
				const nextChildren = helpers.getActualChildren(child);
				if (nextChildren.length > 0) {
					stack.push(...nextChildren.slice());
				}
			}
		}
	}

	return out.reverse();
}

export function shouldFilter<T extends SharedVNode>(
	vnode: T,
	filters: FilterState,
	config: RendererConfig,
	helpers: PreactBindings<T>,
): boolean {
	// Filter text nodes by default. They are too tricky to match
	// with the previous one...
	if (helpers.isTextVNode(vnode)) return true;

	if (helpers.getComponent(vnode) !== null) {
		if (vnode.type === config.Fragment && filters.type.has("fragment")) {
			const parent = helpers.getVNodeParent(vnode);
			// Only filter non-root nodes
			if (parent != null) return true;

			return false;
		}
	} else if (helpers.isElement(vnode) && filters.type.has("dom")) {
		return true;
	}

	if (filters.regex.length > 0) {
		const name = helpers.getDisplayName(vnode, config);
		return filters.regex.some(r => {
			// Regexes with a global flag are stateful in JS :((
			r.lastIndex = 0;
			return r.test(name);
		});
	}

	return false;
}

function mount<T extends SharedVNode>(
	ids: IdMappingState<T>,
	commit: Commit,
	vnode: T,
	ancestorId: ID,
	filters: FilterState,
	domCache: WeakMap<HTMLElement | Text, T>,
	config: RendererConfig,
	profiler: ProfilerState,
	hocs: string[],
	bindings: PreactBindings<T>,
) {
	if (commit.stats !== null) {
		commit.stats.mounts++;
	}

	const root = bindings.isRoot(vnode, config);

	const skip = shouldFilter(vnode, filters, config, bindings);

	if (root || !skip) {
		record: {
			let name = bindings.getDisplayName(vnode, config);

			if (filters.type.has("hoc")) {
				const hocName = getHocName(name);

				// Filter out HOC-Components
				if (hocName) {
					if (name.startsWith("ForwardRef")) {
						hocs = [...hocs, hocName];
						const idx = name.indexOf("(");
						name = name.slice(idx + 1, -1) || "Anonymous";
					} else {
						hocs = [...hocs, hocName];
						break record;
					}
				}
			}

			const id = hasVNodeId(ids, vnode)
				? getVNodeId(ids, vnode)
				: createVNodeId(ids, vnode);
			if (bindings.isRoot(vnode, config)) {
				commit.operations.push(MsgTypes.ADD_ROOT, id);
			}
			commit.operations.push(
				MsgTypes.ADD_VNODE,
				id,
				getDevtoolsType(vnode, bindings), // Type
				ancestorId,
				9999, // owner
				getStringId(commit.strings, name),
				vnode.key ? getStringId(commit.strings, vnode.key) : 0,
				// Multiply, because operations array only supports integers
				// and would otherwise cut off floats
				(vnode.startTime || 0) * 1000,
				(vnode.endTime || 0) * 1000,
			);

			if (hocs.length > 0) {
				addHocs(commit, id, hocs);
				hocs = [];
			}

			// Capture render reason (mount here)
			if (profiler.isProfiling && profiler.captureRenderReasons) {
				commit.operations.push(
					MsgTypes.RENDER_REASON,
					id,
					RenderReason.MOUNT,
					0,
				);
			}

			updateHighlight(profiler, vnode, bindings);

			ancestorId = id;
		}
	}

	if (skip && typeof vnode.type !== "function") {
		const dom = bindings.getDom(vnode);
		if (dom) domCache.set(dom, vnode);
	}

	let diff = DiffType.UNKNOWN;
	let childCount = 0;

	const children = bindings.getActualChildren(vnode);
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child != null) {
			if (commit.stats !== null) {
				diff = getDiffType(child, diff);
				childCount++;
			}

			mount(
				ids,
				commit,
				child,
				ancestorId,
				filters,
				domCache,
				config,
				profiler,
				hocs,
				bindings,
			);
		}
	}

	if (commit.stats !== null) {
		updateDiffStats(commit.stats, diff, childCount);
		recordComponentStats(config, bindings, commit.stats, vnode, children);
	}
}

function resetChildren<T extends SharedVNode>(
	commit: Commit,
	ids: IdMappingState<T>,
	id: ID,
	vnode: T,
	filters: FilterState,
	config: RendererConfig,
	helpers: PreactBindings<T>,
) {
	const children = helpers.getActualChildren(vnode);
	if (!children.length) return;

	const next = getFilteredChildren(vnode, filters, config, helpers);

	// Suspense internals mutate child outside of the standard render cycle.
	// This leads to stale children on the devtools ends. To work around that
	// We'll always reset the children of a Suspense vnode.
	let forceReorder = false;
	if (helpers.isSuspenseVNode(vnode)) {
		forceReorder = true;
	}

	if (!forceReorder && next.length < 2) return;

	commit.operations.push(
		MsgTypes.REORDER_CHILDREN,
		id,
		next.length,
		...next.map(x => getVNodeId(ids, x)),
	);
}

function update<T extends SharedVNode>(
	ids: IdMappingState<T>,
	commit: Commit,
	vnode: T,
	ancestorId: number,
	filters: FilterState,
	domCache: WeakMap<HTMLElement | Text, T>,
	config: RendererConfig,
	profiler: ProfilerState,
	hocs: string[],
	bindings: PreactBindings<T>,
) {
	if (commit.stats !== null) {
		commit.stats.updates++;
	}

	let diff = DiffType.UNKNOWN;

	const skip = shouldFilter(vnode, filters, config, bindings);
	if (skip) {
		let childCount = 0;
		const children = bindings.getActualChildren(vnode);
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (child != null) {
				if (commit.stats !== null) {
					diff = getDiffType(child, diff);
					childCount++;
				}

				update(
					ids,
					commit,
					child,
					ancestorId,
					filters,
					domCache,
					config,
					profiler,
					hocs,
					bindings,
				);
			}
		}

		if (commit.stats !== null) {
			updateDiffStats(commit.stats, diff, childCount);
			recordComponentStats(config, bindings, commit.stats, vnode, children);
		}
		return;
	}

	if (!hasVNodeId(ids, vnode)) {
		mount(
			ids,
			commit,
			vnode,
			ancestorId,
			filters,
			domCache,
			config,
			profiler,
			hocs,
			bindings,
		);
		return true;
	}

	const id = getVNodeId(ids, vnode);
	commit.operations.push(
		MsgTypes.UPDATE_VNODE_TIMINGS,
		id,
		(vnode.startTime || 0) * 1000,
		(vnode.endTime || 0) * 1000,
	);

	const name = bindings.getDisplayName(vnode, config);
	const hoc = getHocName(name);
	if (hoc) {
		hocs = [...hocs, hoc];
	} else {
		addHocs(commit, id, hocs);
		hocs = [];
	}

	const oldVNode = getVNodeById(ids, id);
	updateVNodeId(ids, id, vnode);

	if (profiler.isProfiling && profiler.captureRenderReasons) {
		const reason = getRenderReason(oldVNode, vnode);
		if (reason !== null) {
			const count = reason.items ? reason.items.length : 0;
			commit.operations.push(MsgTypes.RENDER_REASON, id, reason.type, count);
			if (reason.items && count > 0) {
				commit.operations.push(
					...reason.items.map(str => getStringId(commit.strings, str)),
				);
			}
		}
	}

	updateHighlight(profiler, vnode, bindings);

	const oldChildren = oldVNode
		? bindings
				.getActualChildren(oldVNode)
				.map((v: any) => v && getVNodeId(ids, v))
		: [];

	let shouldReorder = false;
	let childCount = 0;

	const children = bindings.getActualChildren(vnode);
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child == null) {
			if (oldChildren[i] != null) {
				commit.unmountIds.push(oldChildren[i]);
			}
		} else if (
			hasVNodeId(ids, child) ||
			shouldFilter(child, filters, config, bindings)
		) {
			if (commit.stats !== null) {
				diff = getDiffType(child, diff);
				childCount++;
			}
			update(
				ids,
				commit,
				child,
				id,
				filters,
				domCache,
				config,
				profiler,
				hocs,
				bindings,
			);
			// TODO: This is only sometimes necessary
			shouldReorder = true;
		} else {
			if (commit.stats !== null) {
				diff = getDiffType(child, diff);
				childCount++;
			}
			mount(
				ids,
				commit,
				child,
				id,
				filters,
				domCache,
				config,
				profiler,
				hocs,
				bindings,
			);
			shouldReorder = true;
		}
	}

	if (commit.stats !== null) {
		updateDiffStats(commit.stats, diff, childCount);
		recordComponentStats(config, bindings, commit.stats, vnode, children);
	}

	if (shouldReorder) {
		resetChildren(commit, ids, id, vnode, filters, config, bindings);
	}
}

export function createCommit<T extends SharedVNode>(
	ids: IdMappingState<T>,
	roots: Set<T>,
	vnode: T,
	filters: FilterState,
	domCache: WeakMap<HTMLElement | Text, T>,
	config: RendererConfig,
	profiler: ProfilerState,
	helpers: PreactBindings<T>,
): Commit {
	const commit = {
		operations: [],
		rootId: -1,
		strings: new Map(),
		unmountIds: [],
		renderReasons: new Map(),
		stats: profiler.recordStats ? createStats() : null,
	};

	let parentId = -1;

	const isNew = !hasVNodeId(ids, vnode);

	if (helpers.isRoot(vnode, config)) {
		if (commit.stats !== null) {
			commit.stats.roots.total++;
			const children = helpers.getActualChildren(vnode);
			commit.stats.roots.children.push(children.length);
		}

		parentId = -1;
		roots.add(vnode);
	} else {
		parentId = getVNodeId(ids, helpers.getAncestor(vnode)!);
	}

	if (isNew) {
		mount(
			ids,
			commit,
			vnode,
			parentId,
			filters,
			domCache,
			config,
			profiler,
			[],
			helpers,
		);
	} else {
		update(
			ids,
			commit,
			vnode,
			parentId,
			filters,
			domCache,
			config,
			profiler,
			[],
			helpers,
		);
	}

	commit.rootId = getVNodeId(ids, vnode);

	return commit;
}
