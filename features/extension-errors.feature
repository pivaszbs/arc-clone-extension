@extension-errors @both-extensions
Feature: Content scripts on a supported video site
  Scenario: The video and command bar content scripts run together
    Given a YouTube fixture with an off-site Favorite icon
    When I open the command bar on the fixture
    Then the extension runs without a content script exception
    And the command bar uses a fallback for the off-site icon

  Scenario: Reinjecting the overlay keeps the active instance
    Given a YouTube fixture with an off-site Favorite icon
    When the extension injects the overlay again
    Then the original overlay is still mounted

  Scenario: The on-page New Tab button opens a separate tab
    Given a YouTube fixture with an off-site Favorite icon
    When I click New Tab in the on-page sidebar
    Then a new tab opens with the Arc command bar focused

  Scenario: Chrome's New Tab keeps the tab Chrome opened
    Given a YouTube fixture with an off-site Favorite icon
    When Chrome opens a standard new tab
    Then the same Chrome tab shows the Arc command bar

  Scenario: Chrome settings open in a tab when chosen through Peek
    Given a YouTube fixture with an off-site Favorite icon
    When I open the command bar on the fixture
    And I choose chrome extensions with Shift Enter
    Then Chrome extensions opens without a blocked iframe
