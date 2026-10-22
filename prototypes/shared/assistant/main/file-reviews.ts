import { randomUUID } from 'node:crypto';
import type { Document, FileProposal } from '../shared/types';
import { Workspace } from './workspace';

// Approval handles are issued by the main process and bound to one workspace.
// A saved chat is a record, not authority to write files after restarting the app.
export class FileReviews {
    private pending = new Map<string, { root: string; destination: string; proposal: FileProposal }>();

    async propose(workspace: Workspace, relative: string, text: string, reason: string, observed?: Document) {
        if (typeof text !== 'string' || text.length > 24000) throw new Error('Propose files up to 24,000 characters.');
        let current: Document | null;
        try {
            current = await workspace.read(relative);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await workspace.newDestination(relative);
            current = null;
        }
        if (current && (!observed || observed.revision !== current.revision))
            throw new Error('Read the complete current file with project_read before proposing edits.');
        const proposal: FileProposal = {
            id: randomUUID(),
            kind: 'file',
            path: relative,
            text,
            original: current?.text ?? '',
            revision: current?.revision ?? null,
            reason: reason.slice(0, 1000),
            status: 'pending',
        };
        // Bound memory; earlier proposals remain visible but require a new model proposal.
        if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
        this.pending.set(proposal.id, {
            root: workspace.root,
            destination: current ? await workspace.resolve(relative) : await workspace.newDestination(relative),
            proposal,
        });
        return { ...proposal };
    }

    async apply(workspace: Workspace, id: string, text: string) {
        const entry = this.pending.get(id);
        if (!entry || entry.root !== workspace.root)
            throw new Error('This review expired or belongs to another project. Ask for a fresh proposal.');
        // Consume before awaiting to prevent concurrent double application.
        this.pending.delete(id);
        try {
            const p = entry.proposal;
            const destination =
                p.revision === null ? await workspace.newDestination(p.path) : await workspace.resolve(p.path);
            if (destination !== entry.destination)
                throw new Error('The file path changed during review. Ask for a fresh proposal.');
            return p.revision === null
                ? await workspace.create(p.path, text)
                : await workspace.save({ path: p.path, text, revision: p.revision });
        } catch (error) {
            this.pending.set(id, entry);
            throw error;
        }
    }

    discard(id: string) {
        this.pending.delete(id);
    }
    clear() {
        this.pending.clear();
    }
}
