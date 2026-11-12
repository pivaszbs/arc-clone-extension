@series-downloads
Feature: Anime365 series downloads
  Scenario: The catalog check lists every episode and chooses the highest Japanese-subtitled download
    Given a catalog with two downloadable episodes and one without Japanese subtitles
    When I check the series for offline viewing
    Then the highest available quality and missing episodes are shown

  Scenario: Offline preserves the dub selected on the episode page
    Given a catalog where the current dub is available for three episodes
    When I check the series for offline viewing
    Then only episodes with the selected dub are offered
    And unchecking the first two episodes submits only episode three

  Scenario: A downloaded series folder pairs video and subtitles offline
    Given the offline study page is open without a network connection
    When I open a downloaded series folder
    Then I can switch episodes and their Japanese captions together without leaving fullscreen

  Scenario: Offline resumes the last watched episode and its playback position
    Given the offline study page is open without a network connection
    When I connect a folder with a saved episode
    Then Offline Study loads the saved episode and position when I reopen it

  Scenario: Offline player keyboard shortcuts work in fullscreen
    Given the offline study page is open without a network connection
    When I connect a folder with a saved episode
    Then I can use Space and the arrow keys to control fullscreen playback

  Scenario: Frame checking queues newly finished downloads and resumes after reloading
    Given the offline study page is open without a network connection
    When I connect a folder with a saved episode
    Then the frame checking queue picks up finished videos and preserves its pause state

  Scenario: Offline suggests skipping themes and counts down before skipping
    Given the offline study page is open without a network connection
    When I connect a folder with a saved episode
    Then I can keep watching the opening and choose between skipping the ending or going to the next episode
