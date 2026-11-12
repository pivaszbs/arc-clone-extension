@pip
Feature: Native picture in picture for standard HTML video
  Video controls use the browser's Picture-in-Picture API from a real click.
  These assertions check native state, not a mocked popup or copied video.

  Scenario: A standard video enters and exits native picture in picture
    Given a standard video page
    When I click its picture in picture button
    Then the original video is in native picture in picture
    When I click its exit picture in picture button
    Then native picture in picture is closed

  Scenario: The control follows a picture in picture window closed externally
    Given a standard video page
    When I click its picture in picture button
    And the browser closes picture in picture
    Then the control offers picture in picture again

  Scenario: Videos inserted dynamically receive controls and removed videos release them
    Given a page that inserts a video dynamically
    Then one picture in picture control is available
    When that video is removed
    Then no picture in picture controls remain

  Scenario: The picture in picture button targets its own video
    Given a page with two standard videos
    When I open the second video in picture in picture
    Then only the second video is in native picture in picture

  Scenario: A website can disable picture in picture for its video
    Given a standard video page
    When the website disables picture in picture on the video
    Then the video has no visible picture in picture button
    When the website enables picture in picture on the video
    Then one picture in picture control is available

  Scenario: A blocked picture in picture request shows a readable error
    Given a video page whose permissions policy blocks picture in picture
    When I click its picture in picture button
    Then native picture in picture is closed
    And the picture in picture control explains that the page blocks it

  Scenario: Picture in picture continues when switching tabs
    Given a standard video page
    When I play the standard video
    And I click its picture in picture button
    And I switch to another browser tab
    Then the original video is in native picture in picture
    And the page still has one original video element
    And the original video is still playing

  Scenario: A video inside an allowed iframe has native picture in picture
    Given a video inside an iframe that allows picture in picture
    When I click the iframe video picture in picture button
    Then the iframe original video is in native picture in picture

  Scenario: The video picture in picture control works with the keyboard
    Given a standard video page
    When I activate picture in picture with the keyboard
    Then the original video is in native picture in picture
