@japanese-page-subtitles
Feature: The study player uses the episode subtitle download
  Scenario: A download link on the episode page supplies timed cues to a cross-origin player
    Given an episode page with an ASS download and an embedded video
    When I open the study player inside the embed
    Then the episode download follows the video clock
    And closing the study player restores the original controls
    And the page offers the highest listed download quality for this episode

  Scenario: The replacement player skips marked sections and studies a clicked subtitle
    Given an episode page with an ASS download and an embedded video
    When I open the study player inside the embed
    Then the player skips the opening and ending using their chapters
    And clicking a subtitle pauses playback and opens the phrase

  Scenario: The embedded player can read its own subtitle download
    Given an episode whose subtitle download is only available from inside its embedded player
    When I open the study player inside the embed
    Then the episode download follows the video clock
    And the page offers the highest listed download quality for this episode

  Scenario: The replacement player can start an episode that loads its video on demand
    Given an episode page with an ASS download and an embedded video
    When the embedded player waits for its Play button to attach the video
    Then Arc Play starts the episode and replaces the original controls

  Scenario: Downloaded files work without a network connection
    Given the offline study page is open without a network connection
    When I open a local episode and its subtitles
    Then offline study shows the Japanese subtitle at the video position
    And Every phrase pauses at the next subtitle boundary and saves a phrase offline
