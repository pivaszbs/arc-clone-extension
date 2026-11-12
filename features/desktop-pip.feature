@desktop-pip
Feature: macOS desktop video panel
  The companion must be configured as a non-activating full-screen auxiliary panel
  before it is shown. Browser PiP state alone does not prove this requirement.

  @anime-only
  Scenario: An offline episode uses the desktop panel
    Given the offline study page is open without a network connection
    When I open a downloaded video across desktops
    Then the desktop panel joins all Spaces and full-screen Spaces
    And the desktop panel decodes the captured video
    And the original video still uses its blob URL
    When the source video pauses and resumes
    Then the desktop panel follows the source playback state
    When I return the desktop video to the page
    Then the desktop player has closed

  Scenario: Video reaches a panel configured for desktops and full-screen Spaces
    Given a standard video page
    When I open the video across desktops
    Then the desktop panel joins all Spaces and full-screen Spaces
    And the desktop panel decodes the captured video
    And the desktop panel keeps receiving a playing live stream
    When the source video pauses and resumes
    Then the desktop panel follows the source playback state
    When I switch to another browser tab
    Then the desktop panel video keeps advancing
    When I return the desktop video to the page
    Then the desktop player has closed

  Scenario: Closing desktop video restores the original player mute state
    Given a standard video page
    When I open the video across desktops
    Then the original player is muted while desktop playback is active
    When I return the desktop video to the page
    Then the original player mute state is restored

  Scenario: Blob video plays in the desktop panel without reopening its URL
    Given a standard video page
    When the video source becomes a blob URL
    And I open the video across desktops
    Then the desktop panel decodes the captured video
    And the original video still uses its blob URL
    When I return the desktop video to the page
    Then the desktop player has closed

  Scenario: Audio and volume reach the desktop player without duplicate page audio
    Given a standard video page
    When I load a video with audio and set its volume
    And I open the video across desktops
    Then the desktop panel retains the captured audio track and requested volume
    And the original player is muted while desktop playback is active
    When I return the desktop video to the page
    Then the original player mute state is restored

  Scenario: Desktop video can be reopened after closing its native connection
    Given a standard video page
    When I open the video across desktops
    Then the desktop panel decodes the captured video
    When I return the desktop video to the page
    And I open the video across desktops
    Then the desktop panel decodes the captured video
    And the desktop panel keeps receiving a playing live stream
    When I return the desktop video to the page
    Then the desktop player has closed
