@japanese-network
Feature: Japanese subtitle traffic
  Scenario: Load Japanese text from an opaque subtitle request inside the player frame
    Given a video on a Japanese learning site with subtitles loaded by the embedded player
    When I scan for subtitles and the player requests its subtitle track
    Then the study panel shows the Japanese cue from the response
