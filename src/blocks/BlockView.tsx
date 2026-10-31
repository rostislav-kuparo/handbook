import type { NodeViewProps } from '@tiptap/react';
import { HtmlBlockView } from './HtmlBlockView';
import { NoteView } from './NoteView';

/** The node view of a block: a note, or an HTML block / drawing (a node never changes its kind). */
export function BlockView(props: NodeViewProps) {
  return props.node.attrs.kind === 'note' ? <NoteView {...props} /> : <HtmlBlockView {...props} />;
}
