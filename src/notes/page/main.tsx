import React from 'react';
import { createRoot } from 'react-dom/client';
import NotesApp from './NotesApp';
import '../../styles.css';
import './notes.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><NotesApp /></React.StrictMode>);
