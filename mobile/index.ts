import { registerRootComponent } from 'expo';
import { createElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import App from './App';

// Gestures (swipes on episodes, swipe down in the player) need the gesture root around the app.
function Root() {
  return createElement(GestureHandlerRootView, { style: { flex: 1 } }, createElement(App));
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => Root);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
