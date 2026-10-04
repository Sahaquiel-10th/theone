import { createRoot } from 'react-dom/client';
import { DispatchPreview } from './DispatchPreview';

// This entry is referenced only by the local preview HTML, never production main.tsx.
createRoot(document.getElementById('root')!).render(<DispatchPreview />);
