import { createRoot } from 'react-dom/client';
import { HelpPage } from './help/page';
import { ready } from './store';

createRoot(document.getElementById('root')!).render(<HelpPage />);
ready();
