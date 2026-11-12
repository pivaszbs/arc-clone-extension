import { mount } from 'svelte';
import NewTab from './NewTab.svelte';

const target = document.getElementById('app')!;
mount(NewTab, { target });
