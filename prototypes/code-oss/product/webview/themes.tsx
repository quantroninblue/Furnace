import { createRoot } from 'react-dom/client';
import { ThemePage } from './themes/page';
import { ready } from './store';

createRoot(document.getElementById('root')!).render(<ThemePage />);
ready();
