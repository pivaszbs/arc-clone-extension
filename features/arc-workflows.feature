Feature: Arc-style browser workflows in a real unpacked extension
  The same scenarios run in two isolated browser installations.
  Native Arc observations and remaining differences are recorded in docs/arc-parity.md.
  Passing this suite does not establish pixel equality with native Arc.

  Scenario: Create a named Space with its own theme
    When I create a Space named "Cucumber Work" using the sidebar
    Then the active Space is "Cucumber Work"
    And the Space persists after reloading the sidebar

  Scenario: Spaces keep Today tabs separate
    Given a Today tab named "Personal-page"
    When I switch to the "Work" Space
    Then Today does not contain "Personal-page"
    When I switch to the "Personal" Space
    Then Today contains "Personal-page"

  Scenario: Favorites are shared between Spaces
    Given a Favorite named "Shared-favorite"
    When I switch to the "Work" Space
    Then the Favorite named "Shared-favorite" is visible

  Scenario: Pinned pages stay out of Today
    Given a pinned page named "Pinned-page"
    Then Today does not contain "Pinned-page"
    And a pinned row named "Pinned-page" is visible

  Scenario: A pin keeps its identity after navigation and Reset Space restores it
    Given a pinned page named "Pinned-page"
    When the pinned tab navigates to "Navigated-page"
    Then Today does not contain "Navigated-page"
    When I reset the Space through the command bar
    Then the pinned tab is back at its saved URL

  Scenario: Rename a saved pin using the sidebar
    Given a pinned page named "Pinned-page"
    When I rename "Pinned-page" to "Project notes"
    Then a pinned row named "Project notes" is visible
    And the pin name persists after reloading the sidebar

  Scenario: Create and collapse a pinned folder
    When I create a pinned folder named "Reading"
    Then the folder is expanded
    When I collapse the folder
    Then the folder is collapsed

  Scenario: Clear Today creates recoverable archive entries
    Given a Today tab named "Disposable-page"
    And a pinned page named "Keep-page"
    When I clear Today using the sidebar
    Then Today does not contain "Disposable-page"
    And a pinned row named "Keep-page" is visible
    And "Disposable-page" is in the archive

  Scenario: Restore an archived page into its original Space
    Given a Today tab named "Restore-me"
    When I clear Today using the sidebar
    And I restore "Restore-me" using the archive drawer
    Then Today contains "Restore-me"
    And "Restore-me" is absent from the archive

  Scenario: Search the archive without changing its records
    Given a Today tab named "Archive-one"
    And a Today tab named "Archive-two"
    When I clear Today using the sidebar
    And I search the archive for "Archive-one"
    Then only "Archive-one" is shown in the archive

  Scenario: Keyboard command bar opens a URL
    When I open "Command-destination" using the keyboard command bar
    Then a real browser tab contains "Command-destination"

  Scenario: Search switches to an existing tab without duplication
    Given a Today tab named "Find-existing"
    When I search for and select "Find-existing" in the command bar
    Then exactly one real browser tab contains "Find-existing"

  Scenario: Escape dismisses the command bar
    When I open the command bar and press Escape
    Then the command bar is closed

  Scenario: Auto archive preferences survive a reload
    When I set auto archive to "After 7 days"
    Then auto archive is set to 168 hours after a reload

  Scenario: Move a Today tab to another Space
    Given a Today tab named "Move-me"
    When I move "Move-me" to the "Work" Space
    Then Today does not contain "Move-me"
    When I switch to the "Work" Space
    Then Today contains "Move-me"

  Scenario: Peek opens a preview without navigating the parent
    Given an active fixture page
    When I Shift-click its destination link
    Then a Peek dialog shows the destination
    And the parent remains at the fixture URL

  Scenario: Little Arc opens a separate popup window
    When I open "Little-Arc-page" in Little Arc
    Then a popup window contains "Little-Arc-page"

  Scenario: Native Split View capability is handled explicitly
    Given a Today tab named "Split-one"
    And a Today tab named "Split-two"
    When I split those two tabs
    Then they share a native split or an explicit unsupported error is returned

  Scenario: The real background alarm archives expired inactive tabs
    Given a Today tab named "Expired-page"
    When the auto archive alarm runs with an elapsed test interval
    Then "Expired-page" is in the archive
    And Today does not contain "Expired-page"

  Scenario: The auto archive alarm preserves active and saved pages
    Given a pinned page named "Saved-from-timer"
    And an active fixture page
    When the auto archive alarm runs with an elapsed test interval
    Then a pinned row named "Saved-from-timer" is visible
    And the active fixture tab is still open

  Scenario: The sidebar fits a narrow browser panel
    When the sidebar is 360 pixels wide
    Then the sidebar has no horizontal overflow
    And its archive and settings controls remain visible
